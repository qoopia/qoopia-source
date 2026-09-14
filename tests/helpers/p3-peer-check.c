#include "../../src/delivery/native/owner-peer.c"
#include <assert.h>
#include <stdio.h>
int main(void) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) { perror("socketpair"); return 2; }
    assert(qp_peer(pair[0], (uint32_t)getuid()) == 0);
    assert(qp_peer(pair[1], (uint32_t)getuid()) == 0);
    /* Real kernel credentials, deliberately mismatched policy UID; no setuid or foreign user claim. */
    assert(qp_peer(pair[0], (uint32_t)getuid() + 1) == -1);
    close(pair[0]); close(pair[1]);
    assert(qp_peer(-1, (uint32_t)getuid()) == -1);
    puts("PASS kernel socketpair credentials: same UID; mismatched expected UID; invalid descriptor refusal");
    return 0;
}
