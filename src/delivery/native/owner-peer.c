/* Narrow Unix stream bridge for Bun FFI. No protocol, database or credentials here. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <poll.h>

/* Kernel identity only; caller-supplied JSON and filesystem ownership are not proof. */
int qp_peer(int fd, uint32_t expected) {
    uid_t uid;
#if defined(__APPLE__)
    gid_t gid;
    if (getpeereid(fd, &uid, &gid) != 0) return -1;
#elif defined(__linux__)
    struct ucred cred;
    socklen_t length = sizeof(cred);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &length) != 0 || length != sizeof(cred)) return -1;
    uid = cred.uid;
#else
#error Unsupported peer credential platform
#endif
    return uid == (uid_t)expected ? 0 : -1;
}
static int prepare(int fd) {
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) return -1;
#ifdef __APPLE__
    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) < 0) return -1;
#endif
    return 0;
}
static int address(const char *name, struct sockaddr_un *addr) {
    if (!name || name[0] != '/' || strlen(name) >= sizeof(addr->sun_path)) return -1;
    memset(addr, 0, sizeof(*addr)); addr->sun_family = AF_UNIX;
    memcpy(addr->sun_path, name, strlen(name) + 1);
    return 0;
}
int qp_listen(const char *name) {
    struct sockaddr_un addr;
    if (address(name, &addr) < 0) return -EINVAL;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -errno;
    if (prepare(fd) < 0 || bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { int error = errno; close(fd); return -error; }
    /* Parent is verified 0700 before bind; no admission before chmod/listen. */
    if (chmod(name, 0600) < 0 || listen(fd, 16) < 0) { int error = errno; close(fd); unlink(name); return -error; }
    return fd;
}
int qp_accept(int listener, uint32_t uid) {
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) return (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? -2 : -1;
    if (prepare(fd) < 0 || qp_peer(fd, uid) < 0) { close(fd); return -1; }
    return fd;
}
int qp_connect(const char *name, uint32_t uid) {
    struct sockaddr_un addr;
    if (address(name, &addr) < 0) return -1;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (prepare(fd) < 0) { close(fd); return -1; }
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        if (errno != EINPROGRESS) { close(fd); return -1; }
        struct pollfd p = {fd, POLLOUT, 0};
        int error = 0; socklen_t n = sizeof(error);
        if (poll(&p, 1, 100) != 1 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &n) < 0 || error) { close(fd); return -1; }
    }
    if (qp_peer(fd, uid) < 0) { close(fd); return -1; }
    return fd;
}
int qp_read(int fd, void *bytes, int size) {
    ssize_t n = recv(fd, bytes, (size_t)size, 0);
    return n < 0 ? ((errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? -2 : -1) : (int)n;
}
int qp_write(int fd, const void *bytes, int size) {
#ifdef __linux__
    ssize_t n = send(fd, bytes, (size_t)size, MSG_NOSIGNAL);
#else
    ssize_t n = send(fd, bytes, (size_t)size, 0);
#endif
    return n < 0 ? ((errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? -2 : -1) : (int)n;
}
void qp_close(int fd) { close(fd); }
