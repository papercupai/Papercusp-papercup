/* Read-only iterator backend for the existing retention holder scanner.
 * Each iterator FD performs a NEW kernel walk. No events or cached census.
 * libbpf CO-RE resolves these minimal records against the running kernel BTF.
 * The userspace owner keeps links/maps in FDs; nothing is pinned in bpffs.
 */
typedef unsigned int u32;
typedef unsigned long long u64;
#define SEC(name) __attribute__((section(name), used))
#define UINT(name, value) int (*name)[value]
#define TYPE(name, value) typeof(value) *name
#pragma clang attribute push(__attribute__((preserve_access_index)), apply_to = record)
struct super_block { u32 s_dev; };
struct inode { u64 i_ino; struct super_block *i_sb; };
struct dentry { struct inode *d_inode; struct dentry *d_parent; };
struct path { void *mnt; struct dentry *dentry; };
struct file { struct path f_path; struct inode *f_inode; };
struct fs_struct { struct path pwd; };
struct pid { u32 level; };
struct task_struct { int tgid; struct fs_struct *fs; struct pid *thread_pid; u64 start_boottime; };
struct seq_file;
struct bpf_iter_meta { struct seq_file *seq; u64 session_id; u64 seq_num; };
struct bpf_iter__task_file { struct bpf_iter_meta *meta; struct task_struct *task; u32 fd; struct file *file; };
struct bpf_iter__task { struct bpf_iter_meta *meta; struct task_struct *task; };
#pragma clang attribute pop
struct config { u64 device, inode, directory, caller, cwd_device, cwd_inode, caller_start_ticks, tick_ns; };
struct stats { u64 files, tasks, failures, fd_end, cwd_end, caller_seen; };
struct { UINT(type, 2); UINT(max_entries, 1); TYPE(key, u32); TYPE(value, struct config); } config SEC(".maps");
struct { UINT(type, 2); UINT(max_entries, 1); TYPE(key, u32); TYPE(value, struct stats); } stats SEC(".maps");
struct { UINT(type, 1); UINT(max_entries, 16384); TYPE(key, u32); TYPE(value, u32); } holders SEC(".maps");
static void *(*lookup)(void *, const void *) = (void *)1;
static long (*update)(void *, const void *, const void *, u64) = (void *)2;
static long (*read_kernel)(void *, u32, const void *) = (void *)113;
#define READ(out, pointer, field) read_kernel(&(out), sizeof(out), __builtin_preserve_access_index(&(pointer)->field))

static __attribute__((always_inline)) int identity(struct dentry *d, u64 *dev, u64 *ino) {
    struct inode *i = 0; struct super_block *sb = 0; u32 device = 0;
    if (!d || READ(i, d, d_inode) || !i || READ(*ino, i, i_ino) || READ(sb, i, i_sb) || !sb || READ(device, sb, s_dev)) return -1;
    *dev = device;
    return *ino ? 0 : -1;
}
static __attribute__((always_inline)) int held(struct dentry *d, struct config *c, struct stats *s) {
    /* Bound traversal rather than silently accepting a truncated ancestry. */
    for (int depth = 0; depth < 128; depth++) {
        u64 dev = 0, ino = 0; struct dentry *parent = 0;
        if (identity(d, &dev, &ino)) { s->failures++; return 0; }
        if (dev == c->device && ino == c->inode) return 1;
        if (!c->directory || dev != c->device) return 0;
        if (READ(parent, d, d_parent) || !parent) { s->failures++; return 0; }
        if (parent == d) return 0;
        d = parent;
    }
    s->failures++;
    return 0;
}
static __attribute__((always_inline)) void record(struct task_struct *task, struct stats *s) {
    u32 pid = 0, value = 1;
    if (READ(pid, task, tgid) || !pid || update(&holders, &pid, &value, 0)) s->failures++;
}
SEC("iter/task_file") int scan_files(struct bpf_iter__task_file *ctx) {
    struct task_struct *task = ctx->task;
    struct file *file = ctx->file;
    u32 zero = 0; struct config *c = lookup(&config, &zero); struct stats *s = lookup(&stats, &zero);
    if (!c || !s) return -1;
    if (!task) { s->fd_end++; return 0; }
    if (!file) { s->failures++; return 0; }
    s->files++;
    if (!c->directory) {
        /* Iterator BTF pointers support verifier-checked, CO-RE field loads.
         * A regular file has no descendant ancestry: compare its actual inode
         * directly, including O_PATH and hard-link aliases. Still visit EVERY
         * descriptor, and keep the same mandatory EOF/error controls. */
        struct inode *i = file->f_inode;
        if (!i) { s->failures++; return 0; }
        if (i->i_ino != c->inode) return 0;
        struct super_block *sb = i->i_sb;
        if (!sb) { s->failures++; return 0; }
        if (sb->s_dev == c->device) record(task, s);
        return 0;
    }
    struct dentry *d = 0;
    if (READ(d, file, f_path.dentry)) { s->failures++; return 0; }
    if (held(d, c, s)) record(task, s);
    return 0;
}
SEC("iter/task") int scan_cwds(struct bpf_iter__task *ctx) {
    struct task_struct *task = ctx->task;
    u32 zero = 0; struct config *c = lookup(&config, &zero); struct stats *s = lookup(&stats, &zero);
    if (!c || !s) return -1;
    if (!task) { s->cwd_end++; return 0; }
    s->tasks++;
    /* Walk every task, with verifier-checked CO-RE loads of its cwd. These
     * are the same fields/identities as the helper reads, not a cached census. */
    struct fs_struct *fs = task->fs;
    if (!fs) return 0; /* Kernel threads have no userspace cwd. */
    struct dentry *d = fs->pwd.dentry;
    u32 pid = task->tgid;
    if (!d || !pid) { s->failures++; return 0; }
    if (pid == c->caller) {
        u64 dev = 0, ino = 0, start = 0; struct pid *identity_pid = 0; u32 level = 1;
        if (identity(d, &dev, &ino) || READ(identity_pid, task, thread_pid) || !identity_pid ||
            READ(level, identity_pid, level) || READ(start, task, start_boottime) || !c->tick_ns) s->failures++;
        /* A caller in a nested PID namespace cannot certify the host, even
         * if a coincident numeric PID and common cwd otherwise match. */
        else if (level == 0 && start / c->tick_ns == c->caller_start_ticks &&
                 dev == c->cwd_device && ino == c->cwd_inode) s->caller_seen++;
    }
    if (!c->directory) {
        struct inode *i = d->d_inode;
        if (!i) { s->failures++; return 0; }
        if (i->i_ino != c->inode) return 0;
        struct super_block *sb = i->i_sb;
        if (!sb) { s->failures++; return 0; }
        if (sb->s_dev == c->device) record(task, s);
        return 0;
    }
    if (held(d, c, s)) record(task, s);
    return 0;
}
char LICENSE[] SEC("license") = "GPL";
