/* MIT license. Original Gori implementation; Linux UAPI values are ABI constants. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#if !defined(__x86_64__) && !defined(__aarch64__)
#error Unsupported Linux architecture
#endif
#define LL_CREATE 444
#define LL_ADD 445
#define LL_RESTRICT 446
#define MIN_ABI 5
#define EXECUTE (1ULL << 0)
#define WRITE_FILE (1ULL << 1)
#define READ_FILE (1ULL << 2)
#define READ_DIR (1ULL << 3)
#define REFER (1ULL << 13)
#define TRUNCATE (1ULL << 14)
#define IOCTL_DEV (1ULL << 15)
#define RO (EXECUTE | READ_FILE | READ_DIR)
#define V1_FS ((1ULL << 13) - 1)
struct ruleset_attr { uint64_t handled_access_fs; };
struct path_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));

static int failure(const char *stage) {
	fprintf(stderr, "gori-landlock-run: %s: %s\n", stage, strerror(errno));
	return 125;
}

static uint64_t rights(int abi) {
	return V1_FS | (abi >= 2 ? REFER : 0) | (abi >= 3 ? TRUNCATE : 0) | (abi >= 5 ? IOCTL_DEV : 0);
}

static int restrict_self(int fd) {
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
	return (int)syscall(LL_RESTRICT, fd, 0);
}

static int add_path(int fd, const char *path, uint64_t access) {
	if (path[0] != '/') { errno = EINVAL; return -1; }
	int parent = open(path, O_PATH | O_CLOEXEC);
	if (parent < 0) return -1;
	struct stat st;
	if (fstat(parent, &st)) { close(parent); return -1; }
	if (!S_ISDIR(st.st_mode)) access &= EXECUTE | READ_FILE | WRITE_FILE | TRUNCATE | IOCTL_DEV;
	struct path_attr attr = { .allowed_access = access, .parent_fd = parent };
	int rc = (int)syscall(LL_ADD, fd, 1, &attr, 0);
	int saved = errno;
	close(parent);
	errno = saved;
	return rc;
}

/* Never let an inherited writable descriptor bypass path-based restrictions. SSH stdio stays open. */
static void close_extra_fds(void) {
#ifdef SYS_close_range
	if (!syscall(SYS_close_range, 3U, ~0U, 0)) return;
#endif
	struct rlimit limit;
	if (getrlimit(RLIMIT_NOFILE, &limit)) _exit(125);
	for (rlim_t fd = 3; fd < limit.rlim_cur; fd++) close((int)fd);
}

static int probe(int abi) {
	/* Restrict a disposable child, then verify an ungranted open really fails. */
	pid_t pid = fork();
	if (pid < 0) return failure("probe fork failed");
	if (!pid) {
		struct ruleset_attr attr = { .handled_access_fs = rights(abi) };
		int fd = (int)syscall(LL_CREATE, &attr, sizeof(attr), 0);
		if (fd < 0 || restrict_self(fd)) _exit(125);
		close(fd);
		int denied = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
		if (denied >= 0 || errno != EACCES) _exit(125);
		_exit(0);
	}
	int status;
	while (waitpid(pid, &status, 0) < 0) {
		if (errno != EINTR) return failure("probe wait failed");
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status)) {
		fprintf(stderr, "gori-landlock-run: probe enforcement failed\n");
		return 125;
	}
	printf("gori-landlock: abi=%d enforcement=%s\n", abi, abi >= MIN_ABI ? "full" : "partial");
	return 0;
}

int main(int argc, char **argv) {
	int separator = 0;
	int probing = argc == 2 && !strcmp(argv[1], "--probe");
	if (!probing) {
		for (int i = 1; i < argc; i += 2) {
			if (!strcmp(argv[i], "--")) { separator = i; break; }
			if ((strcmp(argv[i], "--ro") && strcmp(argv[i], "--rw")) || i + 1 >= argc || argv[i + 1][0] != '/') {
				fprintf(stderr, "gori-landlock-run: invalid arguments\n");
				return 125;
			}
		}
		if (!separator || separator + 1 >= argc) {
			fprintf(stderr, "gori-landlock-run: missing command after --\n");
			return 125;
		}
	}
	int abi = (int)syscall(LL_CREATE, NULL, 0, 1);
	if (abi < 0) return failure("landlock unavailable");
	if (probing) return probe(abi);
	if (abi < MIN_ABI) {
		fprintf(stderr, "gori-landlock-run: ABI %d is below required ABI %d\n", abi, MIN_ABI);
		return 125;
	}
	struct ruleset_attr attr = { .handled_access_fs = rights(abi) };
	int fd = (int)syscall(LL_CREATE, &attr, sizeof(attr), 0);
	if (fd < 0) return failure("ruleset creation failed");
	for (int i = 1; i < separator; i += 2) {
		uint64_t access = !strcmp(argv[i], "--rw") ? attr.handled_access_fs : RO;
		if (add_path(fd, argv[i + 1], access)) { close(fd); return failure("path rule failed"); }
	}
	if (restrict_self(fd)) { close(fd); return failure("restrict_self failed"); }
	close(fd);
	close_extra_fds();
	fprintf(stderr, "gori-landlock: confined abi=%d\n", abi);
	fflush(stderr);
	execvp(argv[separator + 1], &argv[separator + 1]);
	return failure("exec failed");
}
