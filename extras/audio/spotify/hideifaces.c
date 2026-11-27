// Hide Docker/VPN interfaces from Spotify Soloist's interface enumeration.
//
// Soloist's built-in mDNS responder picks one non-loopback address and advertises it as the
// A record of its <device-id>.local hostname. On a host with Docker that is often a bridge
// address such as 172.26.0.1, so phones receive an unreachable address and the device never
// shows up in the Spotify app. Filtering the virtual interfaces at getifaddrs() leaves the
// real LAN interface (wlan0/eth0/enp*), which is what Soloist then advertises.
//
// Loaded with LD_PRELOAD only for the Soloist process; the bridge and the rest of the
// container are unaffected.
#define _GNU_SOURCE
#include <ifaddrs.h>
#include <dlfcn.h>
#include <string.h>

static int hidden(const char *name) {
  static const char *prefixes[] = {
    "docker", "br-", "veth", "virbr", "vmnet", "tailscale", "tun", "tap",
    "wg", "zt", "podman", "cni", "flannel", "kube", "lxc", "lxd", NULL
  };
  if (!name) return 1;
  for (int i = 0; prefixes[i]; i++) {
    if (strncmp(name, prefixes[i], strlen(prefixes[i])) == 0) return 1;
  }
  return 0;
}

int getifaddrs(struct ifaddrs **out) {
  static int (*real)(struct ifaddrs **) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "getifaddrs");
  if (!real) return -1;

  struct ifaddrs *list = NULL;
  int rc = real(&list);
  if (rc != 0) return rc;

  // Unlink virtual interfaces. The removed nodes stay allocated (glibc's freeifaddrs walks
  // the chain), which is a few hundred bytes per enumeration and harmless here.
  struct ifaddrs **link = &list;
  while (*link) {
    if (hidden((*link)->ifa_name)) {
      *link = (*link)->ifa_next;
    } else {
      link = &(*link)->ifa_next;
    }
  }
  *out = list;
  return 0;
}
