// 跨平台独占文件锁统一实现（零外部依赖，原子硬链接发布、单步指纹抢占防 ABA、严格 pid+nonce 归属释放）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function isPidAliveSync(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

export function sleepSyncMs(ms) {
  const dur = Math.max(1, Number(ms) || 1);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, dur);
  } catch {
    const end = Date.now() + dur;
    while (Date.now() < end) { /* fallback */ }
  }
}

export function readLockRecord(lockPath) {
  let st;
  try {
    st = fs.lstatSync(lockPath);
  } catch {
    return null;
  }
  if (!st || !st.isFile()) return null;
  let raw = '';
  try {
    raw = fs.readFileSync(lockPath, 'utf8').trim();
  } catch {
    return null;
  }
  const mtimeMs = Number(st.mtimeMs) || 0;
  const ino = Number(st.ino) || 0;
  const size = Number(st.size) || 0;
  if (!raw) {
    return { pid: 0, at: 0, nonce: '', corrupt: true, empty: true, mtimeMs, ino, size };
  }
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const pid = Number(j && j.pid);
      return {
        pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
        at: Number(j && j.at) || 0,
        nonce: String((j && j.nonce) || ''),
        corrupt: !(Number.isInteger(pid) && pid > 0),
        empty: false,
        mtimeMs,
        ino,
        size,
      };
    } catch {
      return { pid: 0, at: 0, nonce: '', corrupt: true, empty: false, mtimeMs, ino, size };
    }
  }
  const parts = raw.split(/\s+/);
  const pid = Number(parts[0] || '');
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    at: Date.parse(parts[1] || '') || 0,
    nonce: String(parts[2] || ''),
    corrupt: !(Number.isInteger(pid) && pid > 0),
    empty: false,
    mtimeMs,
    ino,
    size,
  };
}

function lockRecordFingerprint(rec) {
  if (!rec) return '';
  const key = [
    rec.ino || 0,
    Math.round(rec.mtimeMs || 0),
    rec.size || 0,
    rec.pid || 0,
    rec.at || 0,
    rec.nonce || '',
    rec.empty ? '1' : '0',
    rec.corrupt ? '1' : '0',
  ].join('|');
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

export function formatLockOwner(lockPath) {
  const rec = readLockRecord(lockPath);
  if (!rec) return '';
  const bits = [];
  if (rec.pid) bits.push('pid ' + rec.pid);
  if (rec.at) bits.push('自 ' + new Date(rec.at).toISOString());
  return bits.join('，');
}

export function inspectLockStale(lockPath, { corruptGraceMs = 1000 } = {}) {
  const rec = readLockRecord(lockPath);
  if (!rec) return '';
  if (!rec.pid || rec.corrupt) {
    // 刚创建尚未写完 PID 的锁在宽限期内不得判陈旧，防止误杀并发建锁者
    const ageMs = rec.mtimeMs > 0 ? Math.max(0, Date.now() - rec.mtimeMs) : Infinity;
    if (corruptGraceMs > 0 && ageMs < corruptGraceMs) return '';
    return '锁里没有可读的 pid（空锁或损坏锁）';
  }
  if (!isPidAliveSync(rec.pid)) {
    return 'pid ' + rec.pid + ' 已不在';
  }
  // 存活 PID 绝不按超龄强拆
  return '';
}

function createLockAtomic(lockPath, payloadStr, nonce) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const initTmp = lockPath + '.init.' + nonce;
  let wroteInit = false;
  try {
    fs.writeFileSync(initTmp, payloadStr, { encoding: 'utf8', flag: 'wx' });
    wroteInit = true;
    try {
      // 先写完整内容再硬链接到目标锁名，保证对并发观察者单步原子可见完整 pid+nonce，不存在“无 owner 窗口”
      fs.linkSync(initTmp, lockPath);
      return { usedFallbackWx: false };
    } catch (e) {
      if (e && e.code === 'EEXIST') throw e;
      if (!e || !['EPERM', 'EXDEV', 'ENOTSUP', 'ENOSYS', 'EACCES'].includes(e.code)) {
        throw e;
      }
    }
  } finally {
    if (wroteInit) {
      try { fs.unlinkSync(initTmp); } catch { /* ignore */ }
    }
  }
  // 不支持硬链接的文件系统回退 wx 创建并一次性写入
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeSync(fd, payloadStr, 0, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return { usedFallbackWx: true };
}

function isRecordDeadOrAgedCorrupt(rec, graceMs) {
  if (!rec) return false;
  if (rec.pid && !rec.corrupt) {
    return !isPidAliveSync(rec.pid);
  }
  const ageMs = rec.mtimeMs > 0 ? Math.max(0, Date.now() - rec.mtimeMs) : Infinity;
  return ageMs >= graceMs;
}

// 在抢占文件已确认属于死亡进程、或回退 wx 写空后超过保守宽限期时，通过二级死指纹串行清理残留抢占文件（存活或新近写入绝不强拆）；
// 若二级死指纹 .dead.<fp> 自身也归属死亡进程或超宽限损坏，则先回收 .dead.<fp> 再重试一次，杜绝永久 BUSY 死锁。
function tryCleanupDeadClaimFile(claimFile, nonce, corruptGraceMs = 1000) {
  const claimGraceMs = Math.max(2000, Number(corruptGraceMs) || 1000);
  const cRec = readLockRecord(claimFile);
  if (!isRecordDeadOrAgedCorrupt(cRec, claimGraceMs)) return;
  const cfp = lockRecordFingerprint(cRec);
  const metaClaim = claimFile + '.dead.' + cfp;
  const metaPayload = JSON.stringify({ pid: process.pid, at: Date.now(), nonce }) + '\n';
  let acquiredMeta = false;
  try {
    createLockAtomic(metaClaim, metaPayload, nonce + 'm');
    acquiredMeta = true;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const mRec = readLockRecord(metaClaim);
      if (isRecordDeadOrAgedCorrupt(mRec, claimGraceMs)) {
        const mfp = lockRecordFingerprint(mRec);
        const metaGuard = metaClaim + '.reap.' + mfp;
        let acquiredGuard = false;
        try {
          createLockAtomic(metaGuard, metaPayload, nonce + 'g');
          acquiredGuard = true;
        } catch (ge) {
          if (ge && ge.code === 'EEXIST') {
            const gRec = readLockRecord(metaGuard);
            if (isRecordDeadOrAgedCorrupt(gRec, claimGraceMs)) {
              const gfp = lockRecordFingerprint(gRec);
              const trashGuard = metaGuard + '.trash.' + nonce;
              let movedDeadGuard = false;
              try {
                fs.renameSync(metaGuard, trashGuard);
                movedDeadGuard = true;
              } catch { /* 已被并发者移走 */ }
              if (movedDeadGuard) {
                const movedRec = readLockRecord(trashGuard);
                if (!movedRec || lockRecordFingerprint(movedRec) === gfp || isRecordDeadOrAgedCorrupt(movedRec, claimGraceMs)) {
                  try { fs.unlinkSync(trashGuard); } catch { /* ignore */ }
                } else {
                  try { fs.renameSync(trashGuard, metaGuard); } catch { /* ignore */ }
                }
              }
              try {
                createLockAtomic(metaGuard, metaPayload, nonce + 'g2');
                acquiredGuard = true;
              } catch {
                acquiredGuard = false;
              }
            }
          }
        }
        if (acquiredGuard) {
          try {
            const mRec2 = readLockRecord(metaClaim);
            if (mRec2 && lockRecordFingerprint(mRec2) === mfp && isRecordDeadOrAgedCorrupt(mRec2, claimGraceMs)) {
              try { fs.unlinkSync(metaClaim); } catch { /* ignore */ }
            }
          } finally {
            releaseExclusiveLock(metaGuard, nonce);
          }
          try {
            createLockAtomic(metaClaim, metaPayload, nonce + 'm2');
            acquiredMeta = true;
          } catch { /* ignore */ }
        }
      }
    }
  }
  if (!acquiredMeta) return;
  try {
    const again = readLockRecord(claimFile);
    if (again && lockRecordFingerprint(again) === cfp && isRecordDeadOrAgedCorrupt(again, claimGraceMs)) {
      try { fs.unlinkSync(claimFile); } catch { /* ignore */ }
    }
  } finally {
    releaseExclusiveLock(metaClaim, nonce);
  }
}

export function acquireExclusiveLock(lockPath, { corruptGraceMs = 1000 } = {}) {
  const nonce = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  const payloadStr = JSON.stringify({ pid: process.pid, at: Date.now(), nonce }) + '\n';

  try {
    createLockAtomic(lockPath, payloadStr, nonce);
    return { ok: true, nonce, stolen: false };
  } catch (e) {
    if (!e || e.code !== 'EEXIST') {
      return { ok: false, code: (e && e.code) || 'EIO', error: e };
    }
  }

  const initialRec = readLockRecord(lockPath);
  const initialWhy = inspectLockStale(lockPath, { corruptGraceMs });
  if (!initialRec || !initialWhy) {
    return { ok: false, code: 'BUSY', owner: formatLockOwner(lockPath) };
  }

  // 防 ABA 单步原子接管：用目标死锁指纹 fp0 作为抢占文件名，通过 createLockAtomic 单步原子发布含完整 pid+nonce 的抢占锁
  // 不存在 mkdir 后再写 owner 的两步空窗；若遇旧进程崩溃残留且确认死 PID，再由二级死指纹串行回收
  const fp0 = lockRecordFingerprint(initialRec);
  const claimFile = lockPath + '.reap.' + fp0;
  try {
    createLockAtomic(claimFile, payloadStr, nonce + 'c');
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      tryCleanupDeadClaimFile(claimFile, nonce, corruptGraceMs);
    }
    return { ok: false, code: 'BUSY', owner: formatLockOwner(lockPath) };
  }

  try {
    const curRec = readLockRecord(lockPath);
    if (curRec) {
      const curFp = lockRecordFingerprint(curRec);
      const recheckWhy = inspectLockStale(lockPath, { corruptGraceMs });
      if (curFp !== fp0 || !recheckWhy) {
        return { ok: false, code: 'BUSY', owner: formatLockOwner(lockPath) };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (ue) {
        if (!ue || ue.code !== 'ENOENT') {
          return { ok: false, code: (ue && ue.code) || 'EIO', error: ue, owner: formatLockOwner(lockPath) };
        }
      }
    }

    try {
      createLockAtomic(lockPath, payloadStr, nonce + 'r');
      return { ok: true, nonce, stolen: true, why: initialWhy };
    } catch (e2) {
      return {
        ok: false,
        code: (e2 && e2.code) === 'EEXIST' ? 'BUSY' : ((e2 && e2.code) || 'EIO'),
        owner: formatLockOwner(lockPath),
        error: e2,
      };
    }
  } finally {
    releaseExclusiveLock(claimFile, nonce);
  }
}

export function releaseExclusiveLock(lockPath, expectedNonce) {
  if (!lockPath || !expectedNonce) return false;
  try {
    const cur = readLockRecord(lockPath);
    if (!cur) return false;
    // 严格要求 PID 与非空 nonce 均完全匹配，防止旧持有者或空 nonce 误删新锁
    if (cur.pid === process.pid && cur.nonce && cur.nonce === expectedNonce) {
      fs.unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch { /* 已不在 */ return false; }
}

export function withExclusiveFileLock(lockPath, fn, { timeoutMs = 3000, corruptGraceMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let acq = null;
  while (true) {
    acq = acquireExclusiveLock(lockPath, { corruptGraceMs });
    if (acq.ok) break;
    if (acq.code !== 'BUSY') {
      throw acq.error || new Error('获取文件锁失败：' + lockPath + ' (' + acq.code + ')');
    }
    if (Date.now() >= deadline) {
      const err = new Error('获取文件锁超时：' + lockPath + (acq.owner ? '（持有者 ' + acq.owner + '）' : ''));
      err.code = 'ELOCKTIMEOUT';
      throw err;
    }
    sleepSyncMs(20);
  }
  try {
    return fn();
  } finally {
    releaseExclusiveLock(lockPath, acq.nonce);
  }
}
