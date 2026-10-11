import { readFileSync } from 'node:fs'
import { dlopen, FFIType } from 'bun:ffi'

const unknownIdentity = () => new Error('Herdr process_identity_unknown; inspect the owned pane and reconcile before retrying.')

// Public macOS APIs from libproc.h and sys/sysctl.h. Load lazily so Linux
// and configuration-free commands never try to open a Darwin library.
function openDarwin() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  })
}
let darwin: ReturnType<typeof openDarwin> | undefined
let darwinBootId: string | undefined

function darwinBirthIdentity(pid: number): string {
  const { symbols } = darwin ??= openDarwin()
  if (darwinBootId === undefined) {
    const uuid = Buffer.alloc(37)
    const size = new BigUint64Array([BigInt(uuid.length)])
    if (symbols.sysctlbyname(Buffer.from('kern.bootsessionuuid\0'), uuid, size, null, 0) !== 0 ||
      size[0] !== 37n || uuid[36] !== 0) throw unknownIdentity()
    const bootId = uuid.toString('utf8', 0, 36)
    if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(bootId)) throw unknownIdentity()
    darwinBootId = bootId.toLowerCase()
  }

  // RUSAGE_INFO_V0: public, fixed 96-byte rusage_info_v0 on arm64/x86_64.
  // ri_proc_start_abstime is a kernel monotonic birth timestamp, not ps's
  // second-resolution wall time. Keep all 64 bits to detect PID reuse.
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h
  const usage = Buffer.alloc(96)
  if (symbols.proc_pid_rusage(pid, 0, usage) !== 0) throw unknownIdentity()
  const birth = usage.readBigUInt64LE(80)
  if (birth === 0n || usage.readBigUInt64LE(88) !== 0n) throw unknownIdentity()
  return `darwin:${darwinBootId}:${pid}:${birth}`
}

/** Boot + PID + kernel birth time identify an occupant across CLI restarts,
 * process restarts, PID reuse and machine reboots. Missing identity fails closed. */
export function processBirthIdentity(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw unknownIdentity()
  if (process.platform === 'darwin') return darwinBirthIdentity(pid)
  if (process.platform !== 'linux') throw unknownIdentity()
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const birth = fields[19]
  if (!birth || !/^\d+$/.test(birth) || fields[0] === 'Z' || fields[0] === 'X') throw unknownIdentity()
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!bootId) throw unknownIdentity()
  return `${bootId}:${pid}:${birth}`
}
