#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* File managers commonly open executable .sh files in an editor. This ELF
 * entry point opens the adjacent sealed application without a shell or PATH. */
int main(int argc, char **argv) {
    char executable[PATH_MAX + 1];
    ssize_t length = readlink("/proc/self/exe", executable, PATH_MAX);
    if (length < 0 || length == PATH_MAX) {
        fputs("Qoopia: cannot locate the application launcher.\n", stderr);
        return 1;
    }
    executable[length] = '\0';
    char *name = strrchr(executable, '/');
    if (name == NULL || (size_t)(name + 1 - executable) + sizeof("qoopia") > sizeof(executable)) {
        fputs("Qoopia: application path is too long.\n", stderr);
        return 1;
    }
    name[1] = '\0';
    if (chdir(executable) != 0) {
        perror("Qoopia: cannot open the application folder");
        return 1;
    }
    memcpy(name + 1, "qoopia", sizeof("qoopia"));
    char **arguments = calloc((size_t)argc + 2, sizeof(*arguments));
    if (arguments == NULL) return 1;
    arguments[0] = executable;
    arguments[1] = "open";
    for (int i = 1; i < argc; i++) arguments[i + 1] = argv[i];
    execv(executable, arguments);
    perror("Qoopia: cannot start the application");
    free(arguments);
    return 1;
}
