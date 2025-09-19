---
title: "Linux Networking for Kubernetes Users"
date: 2024-01-03
layout: "post.njk"
description: "This document provides an overview of the components that enable network communication between pods, nodes, and the external world."
---

# Linux Networking for Kubernetes Users

*Last updated: [[2025-09-18]]*

This document provides an overview of the components that enable network communication between pods, nodes, and the external world.

---

In [[Kubernetes]], the CNI (Container Network Interface) is responsible for equipping pods with network connectivity. Usually, the CNI creates a bridge interface on the worker node. This bridge acts as a Layer 2 virtual switch connecting all Pods on that node. Not all CNIs create a bridge. The AWS VPC CNI[^1] is one such example. We'll discuss AWS VPC CNI later. For now, let's start with how CNIs like Calico work. These create an overlay network in which every pod gets a private IP address and they use a bridge on the worker node for container networking.

When a new Pod comes to life, the CNI first gives it its own isolated network namespace. Inside this namespace, the CNI creates a network interface and assigns it an IP address, so the Pod can communicate.

> A *network namespace* is a feature in Linux that allows you to create isolated network environments within a single Linux system. Each network namespace has its own network stack including network interfaces, routing tables, firewall rules and other network-related resources. This isolation allows you to run multiple independent network environments on the same physical or virtual machine, keeping them separate from each other. [^2]

![[IMG_2965.jpeg|Figure: Linux Network Namespaces(https://wizardzines.com/comics/network-namespaces/)]]

Each Pod (residing in its own network namespace) then receives a `veth` pair. A *`veth`* pair consists of two interconnected virtual network interfaces. Whatever goes into one end comes out the other, and vice-versa. 

Here's how the `veth` pair bridges the pod with the worker node's network:
1. Veth Pair Creation -- The CNI plugin creates a `veth` pair. Let's call the two ends `veth0-pod` and `veth0-bridge`.
2. `veth0-pod` into Pod Namespace -- One end of the `veth` pair (`veth0-pod`) is moved into the Pod's newly created network namespace (`ip link set veth0-pod netns <pod-namespace>`). Inside the Pod, this interface is typically renamed to a standard name like `eth0` (`ip link set veth0-pod name eth0`). This `eth0` is what the applications running in the Pod see and use to send and receive network traffic.
3. `veth0-bridge` to the Bridge -- The other end of the `veth` pair (`veth0-bridge`) remains in the host's network namespace and is then attached to the CNI-created Linux bridge (e.g., `cni0`, `br0`, or `docker0`).

![[Kubernetes Networking-1758132101915.webp|Figure: How pods communicate with other pods]]

## Inter-Pod Communication

When pod-A on a node wants to communicate with pod-B on the *same* node, traffic from pod A's `eth0` goes through its veth end (`veth0-pod`), out the other veth end (`veth0-bridge`), onto the bridge. The bridge then, acting as a Layer 2 switch, forwards the traffic directly to the `veth0-bridge` end of pod B, which then enters pod B's namespace via its `veth0-pod` (internal `eth0`). The bridge itself is connected to the host's network stack. 

![[Kubernetes-Networking-1758168916151.webp|Figure: Container network setup on a node]]

To connect pods with services, pods on other nodes, and the external world, Kubernetes relies on the Linux kernel's built-in **netfilter** framework, which operates at Layer 3.

## AWS VPC CNI

The AWS VPC CNI plugin takes a different approach from traditional CNIs. Instead of creating a bridge and using NAT for external communication, it leverages AWS VPC networking primitives directly. Each pod gets a real VPC IP address from the subnet where the worker node resides.[^3]

When a pod starts, the VPC CNI performs these steps:
1. Get IP Address – The Local IP Address Manager (L-IPAM) provides a secondary IP address from its warm pool
2. Create veth Pair – One end goes to the pod's network namespace, the other stays on the host
3. Configure Pod Namespace:
    - Assign the VPC IP address to the pod's `eth0` interface with a `/32` subnet mask
    - Add a default route via `169.254.1.1` (a link-local address)
    - Add a static ARP entry mapping the gateway to the host-side veth interface
4. Configure Host Side:
    - Add a host route for the pod's IP pointing to the host-side veth interface
    - Add policy routing rules to ensure proper traffic flow

Host-side veth interface:
• Remains in the host's network namespace (the default namespace)
• Gets a name like `eni123abc456` or similar AWS-generated identifier
• Acts as the "gateway" for the pod's traffic
• Has the MAC address that the pod sees as its default gateway (169.254.1.1)

Pod-side veth interface:
• Gets moved into the pod's isolated network namespace using
`ip link set veth-pod netns <pod-namespace>`
• Gets renamed to `eth0` inside the pod (so applications see a standard interface name)
• Receives the actual VPC IP address (like 192.168.82.72/32)

```sh
# Inside the container
$ ip addr show
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host
       valid_lft forever preferred_lft forever
3: eth0@if29: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc noqueue state UP group default
    link/ether ce:1e:02:2f:7e:65 brd ff:ff:ff:ff:ff:ff link-netnsid 0
    inet 192.168.82.72/32 scope global eth0
       valid_lft forever preferred_lft forever
    inet6 fe80::cc1e:2ff:fe2f:7e65/64 scope link
       valid_lft forever preferred_lft forever
       
$ ip route show
default via 169.254.1.1 dev eth0
169.254.1.1 dev eth0 scope link

$ ip neighbour
169.254.1.1 dev eth0 lladdr 8e:62:30:ec:7f:37 PERMANENT
```

![[Kubernetes Networking-1758212585275.webp|Figure: Pinging one pod from another]]

## Netfilter and Packet Routing in Kubernetes

[netfilter](https://netfilter.org) is a collection of packet filtering hooks in Linux kernel network stack. Every *routable* packet (operating at Layer 3) in the system triggers netfilter hooks as it passes through the stack. We can use these hooks to inspect, modify, or filter traffic.

Kubernetes relies on netfilter hooks to ensure that pods, which usually have internal, private IP addresses, can communicate with each other and with external services. netfilter is not used for pod-to-pod communication on the same node, which happens at Layer 2. 

There are five netfilter hooks:
- `PREROUTING` -- The first hook when a packet arrives on the node from the outside world. DNAT (Destination Network Address Translation) is an example of this hook. `kube-proxy`uses this chain to change the destination IP of incoming Service traffic from a ClusterIP to a backend pod IP.
- `INPUT` -- For packets meant for the local node itself. It's the final hook for incoming traffic.  
- `FORWARD` -- Packets not meant for the local node go through this hook (e.g., pod-to-pod communication on different Nodes, Pod to external service). INPUT and FORWARD hooks controls inter-pod communication and network policies. 
- `OUTPUT` -- This is the first hook all outgoing traffic hit.  
- `POSTROUTING` -- The last hook for traffic leaving the node. It's used for tasks such as changing the return address on an envelope. SNAT (Source NAT) is an example. When a pod communicates externally, its source IP (the pod's internal IP) is translated to the node's IP here, so external services can send replies back to the node.

| Hook            | When the kernel hits it                 | Typical Kubernetes use-case                                    |
| --------------- | --------------------------------------- | -------------------------------------------------------------- |
| **PREROUTING**  | First touch on arriving packet          | kube-proxy DNAT: ClusterIP → pod IP                            |
| **INPUT**       | Packet destined to local host           | NodePort/health-check traffic to kubelet or hostNetwork pod    |
| **FORWARD**     | Packet just passing through node        | Pod-to-pod on different nodes; enforced by NetworkPolicy rules |
| **OUTPUT**      | First touch on locally-generated packet | Pod egress or kube-apiserver outbound webhook calls            |
| **POSTROUTING** | Last touch before wire                  | SNAT (MASQUERADE) pod IP → worker node IP for external replies |

We can model three kinds of traffic flows based on their destination:
- Traffic passing through the node: This is traffic not destined for the node itself, such as pod-to-pod communication on different nodes. This traffic follows the path: `PREROUTING` → `FORWARD` → `POSTROUTING`.
- Incoming traffic to the node -- This is traffic directed at the node itself, like a request to a service running on the host. This traffic follows the path: `PREROUTING` → `INPUT`.
- Outgoing traffic from the node -- This is traffic originating from the node itself. This traffic follows the path: `OUTPUT` → `POSTROUTING`.[^4]

![[Kubernetes Networking-1758135896763.webp|Figure: A simplified diagram of Netfilter hooks and packet flow]]

Netfilter allows traffic originating from pods to be routed out of the node's primary network interface for external communication (with SNAT applied by `netfilter`, as we discussed). Similarly, incoming traffic destined for a Pod (e.g., via a Service's DNAT) arrives at the Node, is processed by `netfilter`, and then routed to the correct Pod via the bridge and its associated `veth` pair.

For pod-to-external traffic (outside the VPC), the VPC CNI uses SNAT to translate the pod's VPC IP to the node's primary ENI IP address. This is handled by an iptables rule:

```bash
-A POSTROUTING ! -d <VPC-CIDR> -m comment --comment "kubernetes: SNAT for outbound traffic from cluster" -m addrtype ! --dst-type LOCAL -j SNAT --to-source <Primary IP on the Primary ENI>
```

This ensures that external services see traffic as coming from the node's IP, allowing proper return traffic routing.

[Iptables](https://en.wikipedia.org/wiki/Iptables) was the standard packet-filtering solution for a long time, but has been slowly replaced by [nftables](https://lwn.net/Articles/867185/). Nftables was in turn supplanted in some areas by eBPF.[^5]

### Netfilter Tables and Chains

Whenever a network packet reaches one of Netfilter's hooks (like `PREROUTING` or `INPUT`), the Linux kernel examines it to decide what to do with it; whether to accept, drop, modify, or forward it.

As mentioned earlier, you can define custom rules at each hook to control the traffic. These rules aren't attached directly to the hooks; instead, they're organized into "chains" within specific Netfilter "tables". 

The structure is: Table -> Chain -> Rule. 

A *table* is a collection of chains. And a *chain* is an ordered list of rules. Each rule has a match condition (for example, if source IP is 1.1.1.1) and an action (such as ACCEPT, DROP, DNAT).

> A chain is a checklist of *rules*. Each rule says "if the packet header looks like this, then here's what to do with the packet". If the rule doesn't match the packet, then the next rule in the chain is consulted. Finally, if there are no more rules to consult, then the kernel looks at the chain *policy* to decide what to do. In a security-conscious system, this policy usually tells the kernel to DROP the packet.[^6]

When a packet hits a hook (let's say `PREROUTING`), the kernel checks tables that are registered for the hook. Each table has a set of built-in chains corresponding to the hooks.

Netfilter has six tables[^7]:
- `filter` table (default) --  This table is used for filtering packets (allowing or denying them). It contains the `INPUT`, `FORWARD`, and `OUTPUT` chains.
- `nat` table -- Used for NAT (modifies packet source or destination addresses/ports). It contains the `POSTROUTING` (SNAT), `PREROUTING` (DNAT),  and `OUTPUT` chains.
- `mangle` table -- Used for modifying packet headers (i.e. modify TTL, ToS, etc). It contains `PREROUTING`, `INPUT`, `FORWARD`, `OUTPUT`, and `POSTROUTING` chains.
- `raw` table -- Used for very early processing of packets, primarily to configure connection tracking (e.g., skip connection tracking). It contains `PREROUTING` and `OUTPUT` chains.
- `security` table -- Used for mandatory access control (MAC) networking rules. It contains `PREROUTING`, `INPUT`, `FORWARD`, `OUTPUT`, and `POSTROUTING` chains.

| Tables ↓/Chains→ | PREROUTING | INPUT | FORWARD | OUTPUT | POSTROUTING |
| ---------------- | ---------- | ----- | ------- | ------ | ----------- |
| raw              | ✓          |       |         | ✓      |             |
| filter           |            | ✓     | ✓       | ✓      |             |
| nat (DNAT)       | ✓          |       |         | ✓      |             |
| mangle           | ✓          | ✓     | ✓       | ✓      | ✓           |
| security         |            | ✓     | ✓       | ✓      |             |
| nat (SNAT)       |            |       |         |        | ✓           |

## Conntrack

*Conntrack (Connection Tracking)* is a `netfilter` component that tracks the state of all network connections (or "flows") passing through the Linux kernel. It's used for stateful operations like NAT and firewalls.

For each flow (e.g., TCP session, UDP exchange), `conntrack` stores the following information:
- Source IP and Port
- Destination IP and Port
- Protocol (TCP, UDP, ICMP)
- Connection State (TCP ESTABLISHED, TIME_WAIT, etc.)
- Original and Reply Direction Tuples -- Vital for NAT to correctly reverse translations for returning packets.

Kubernetes environments, especially with high connection churn, can generate a very high volume of network connections. This can result in the conntrack table getting full. 

Common Issues and Adjustments:
- **Conntrack Table Full:** If the table fills up, new connections are dropped, causing network failures. You'll see "nf_conntrack: table full, dropping packet" in logs.
    - **Solution:** Increase `net.netfilter.nf_conntrack_max`.
    - A common rule of thumb is `RAM_in_MB * 16`. For example, on a 32GB node: `sudo sysctl -w net.netfilter.nf_conntrack_max=524288`. This can be made persistent in `/etc/sysctl.conf`.    

### Monitoring Conntrack

You can monitor `conntrack` usage to identify potential issues:
- Check current connection count --  `cat /proc/sys/net/netfilter/nf_conntrack_count`
- Max entries -- `cat /proc/sys/net/netfilter/nf_conntrack_max`
- Detailed info -- `conntrack -L` (can be very verbose on busy systems)
- Errors in dmesg -- `dmesg | grep nf_conntrack`

## [[eBPF]] And Netfilter

The `bpfilter` project enhances Netfilter by converting `iptables` or `nftables` rules into high-performance eBPF programs that run entirely in kernel space[^8]. Traditional Netfilter can be slow for complex rules that require copying packets to user-space for tasks like deep inspection or observability. eBPF eliminates these copies by processing packets directly at Netfilter's hooks (like PREROUTING or INPUT). [^9]

The core motivation behind `bpfilter` is **performance**. While Netfilter is powerful, its traditional rule processing can become a bottleneck with very large and complex rule sets (common in large Kubernetes with a high Pod churn rate). By converting these rules into eBPF programs, `bpfilter` leverages eBPF's advantages. Note that, `bpfilter` is not a full replacement for Netfilter but a layer that translates rules into eBPF for faster processing.

Instead of hard-coded hooks, eBPF programs can be attached to various **event points** in the kernel, including network-related ones. When an event occurs (e.g., a packet arrives at an interface), the attached eBPF program is executed.

eBPF is flexible and performant because:   
- Programs are written in a restricted C-like language, compiled to bytecode, and then **JIT-compiled** to native machine code for extreme speed.
- They run directly in the kernel space, avoiding costly context switches between user and kernel space.
- A **verifier** ensures programs are safe, won't crash the kernel, and will terminate.

CNIs like Cilium use eBPF and don't need iptables. Cilium provides an ==eBPF-based `kube-proxy` replacement==. Instead of `iptables` rules, Cilium injects eBPF programs directly into the kernel's data path (e.g., using `XDP` or `TC` hooks). These eBPF programs handle the load balancing, network policy enforcement, and DNAT/SNAT for services much more efficiently using highly optimized eBPF maps (kernel data structures) for service endpoints. This eliminates the `iptables` overhead and significantly improves performance and scalability. You can enable this mode when installing Cilium.

### Network Policies

Standard Kubernetes Network Policies are often implemented by CNI plugins by generating `iptables` (or eBPF) rules. These rules are added to the `FORWARD` chain (and sometimes `INPUT`/`OUTPUT` for host policies).

Cilium (via the Cilium agent) takes Kubernetes `NetworkPolicy` and its extended CRDs like `CiliumNetworkPolicy`, compiles them into eBPF programs and maps, and attaches eBPF programs (for example at ingress TC hooks on pod `veth` interfaces) to inspect packets as they enter a pod's network namespace. For L3/L4 policies this is handled entirely in-kernel. For L7/application-layer policies (e.g. HTTP, gRPC, DNS), Cilium uses an Envoy proxy helper (running as part of the Cilium infrastructure) to enforce or assist in policy. This approach yields more granular control, faster policy enforcement, and avoids many of the overheads of traditional iptables rule-processing.[^10]

### Pod-to-Pod Networking in Cilium

Even for basic pod-to-pod communication, Cilium leverages eBPF. Traditionally, packets between pods might traverse a Linux bridge and then rely on the kernel's routing table, potentially hitting `iptables` `FORWARD` chain rules.

Cilium optimizes the data path for pod-to-pod communication. While the underlying virtual interfaces (veth pairs, bridges) might still be present, the actual forwarding logic and encapsulation/decapsulation (for overlay networks like VXLAN or Geneve) are handled by highly optimized eBPF programs[^11]. This avoids the traditional Linux bridge processing path and `iptables` traversal for regular pod traffic, leading to lower latency and higher throughput.

## Further Reading

- [The Architecture of Iptables and Netfilter • CloudSigma](https://blog.cloudsigma.com/the-architecture-of-iptables-and-netfilter/#:~:text=It%20indicates%20the%20chains%20that,✓)
- [Netfilter’s connection tracking system](https://people.netfilter.org/pablo/docs/login.pdf)
- https://more.suse.com/rs/937-DCH-261/images/DivingDeepIntoKubernetesNetworking_final.pdf

---

[^1]: https://github.com/aws/amazon-vpc-cni-k8s
[^2]: https://cloudnativenow.com/topics/cloudnativenetworking/understanding-kubernetes-networking-architecture/
[^3]: [amazon-vpc-cni-k8s/docs/cni-proposal.md at master · aws/amazon-vpc-cni-k8s · GitHub](https://github.com/aws/amazon-vpc-cni-k8s/blob/master/docs/cni-proposal.md#solution-components)
[^4]: [Netfilter’s connection tracking system](https://people.netfilter.org/pablo/docs/login.pdf)
[^5]: [Faster firewalls with bpfilter LWN.net](https://lwn.net/Articles/1017705/?utm_source=chatgpt.com)
[^6]: [Linux 2.4 Packet Filtering HOWTO: How Packets Traverse The Filters](https://www.netfilter.org/documentation/HOWTO/packet-filtering-HOWTO-6.html)
[^7]: [A Deep Dive into Iptables and Netfilter Architecture \| DigitalOcean](https://www.digitalocean.com/community/tutorials/a-deep-dive-into-iptables-and-netfilter-architecture)
[^8]: https://linux-audit.com/bpfilter-next-generation-linux-firewall/
[^9]: [BPF comes to firewalls LWN.net](https://lwn.net/Articles/747551/)
[^10]: [Network Policy — Cilium 1.9.18 documentation](https://docs.cilium.io/en/v1.9/concepts/kubernetes/policy/)
[^11]: [Routing — Cilium 1.18.2 documentation](https://docs.cilium.io/en/stable/network/concepts/routing/?utm_source=chatgpt.com)