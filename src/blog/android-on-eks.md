---
title: "Running Android on Amazon EKS"
date: 2024-10-05
layout: "post.njk"
description: ""
---

# Running Android on Amazon EKS

Teams that develop software meant to run on Android often need virtual Android devices for development and testing. These virtual devices, aka Android Emulators, enable development and testing workflows without requiring a physical Android device. While they are flexible and more cost-effective, managing multiple instances of emulators at scale can become cumbersome. This post shows how to run virtual Android devices using [Cuttlefish](https://github.com/google/android-cuttlefish) and Amazon EKS. 

*Cuttlefish* is a configurable virtual Android device that runs on Linux x86 and ARM hardware. Unlike traditional Android emulators, which require dedicated hardware or virtual machines, Cuttlefish runs in a container. This is a significant advantage as it means that you can create multiple virtual Android devices on the same hardware. It allows you to maximize hardware utilization. 

And, you'd definitely want to maximize hardware utilization. Cuttlefish requires that the underlying host machine has Kernel-based Virtual Machine (KVM). In AWS, KVM is only available on bare metal instances, which aren't cheap. At the time of writing, the cheapest bare metal instance is C6g.metal. Running one C6g will set you back $2.176 per hour in the US East (N. Virginia) AWS Region. 

How can you maximize hardware utilization? The answer is Kubernetes. Couple Cuttlefish with Kubernetes and you can orchestrate workloads that require virtual Android devices easily. This combination:
- Simplifies creation and termination of virtual Android devices
- Provides a consistent environment for development and testing
- Enforces resource allocation (using Kubernetes requests and limits)

## What Do You Need?

To run Cuttlefish on EKS, you'll need the following:
- An EKS cluster
- A managed node group or Karpenter with a node pool (with bare metal instances, such as, c6g.metal)
- Cuttlefish container image

## Cuttlefish Container Image

Prebuilt Cuttlefish container mages are available on [GitHub](https://github.com/google/android-cuttlefish/actions/workflows/artifacts.yaml?query=event%3Apush). For my setup, I chose to build the container image instead of using a prebuilt one. The process is straightforward:

```sh
git clone https://github.com/google/android-cuttlefish.git
cd android-cuttlefish/docker
./image-builder.sh
```

Once the image builds, you'll have a `cuttlefish-orchestration` image on your machine. Keep in mind that the architecture of your image will be the same as the host machine. That is, if you run the `image-builder.sh` script on an ARM machine, you'll get an ARM image. If you want to run Cuttlefish on x86, use an x86 machine to build the image. Alternatively, you can use [Docker Multi-platform builds](https://docs.docker.com/build/building/multi-platform/) to build x86 and ARM images on the same machine. 

Besides the container image, you need two additional files to run a virtual Android device using Cuttlefish: the device image and the associated host package. The detailed instructions to get these files are available in [Cuttlefish documentation](https://source.android.com/docs/devices/cuttlefish/get-started). 

Here's a summary:
1. Go to http://ci.android.com/
2. Enter a branch name (the default is `aosp-main`)
3. Under aosp_arm for ARM or aosp_cf_x86_64_phone for x86, click on the download button
4. In the Details panel that appears when you click the download button, switch to the "Artifacts" tab
5. On the artifacts panel, download these two files:
  1. The device image file: `aosp_cf_x86_64_phone-img-xxxxxx.zip`
  2. The host package: `cvd-host_package.tar.gz`

![Figure 1. The Android Continuous Integration site http://ci.android.com/](/images/pasted-image-20241101142222.webp)

![Figure 2. The "Artifacts" tab in the Details panel.](/images/pasted-image-2020241101142823.webp)

Now, we must create a custom Cuttlefish container image that includes the device image and host package files. 

Place the two files in a clean directory. In that directory, create a Dockerfile:

```Dockerfile
FROM cuttlefish-orchestration

WORKDIR /opt/cuttlefish-android

COPY aosp_cf_arm64_only_phone-img-*.zip .

ADD cvd-host_package.tar.gz .

RUN apt-get install -y zip

RUN unzip ./aosp_cf_arm64_only_phone-img-*.zip

RUN rm aosp_cf_arm64_only_phone-img-*.zip
```

Finally, build the image and then push it to a container registry:

```sh
docker build . -t cuttlefish-custom:v1
```

## Configuring the Node

Cuttlefish requires that the host machine has `vhost_vsock` and `vhost_net`kernel modules loaded. These kernel modules are part of the `virtio` framework and enable efficient I/O and network communication between the virtual Android device and the host machine. 

To load these modules on an existing node, run:

```sh
sudo modprobe vhost_vsock vhost_net 
```

You can enable these kernel modules at node startup. If you use managed node groups, you'll have to create a launch template. The instructions are [here](https://docs.aws.amazon.com/eks/latest/userguide/launch-templates.html#launch-template-user-data). 

For Karpenter, you'll include the commands to load these kernel modules in the EC2NodeClass configuration. Here's an example of an ARM NodePool and EC2NodeClass :

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c6g.metal"]
      nodeClassRef:
        name: cuttlefish
---
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: cuttlefish
spec:
  amiFamily: AL2
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi # Recommended 
        volumeType: gp3
  role: "KarpenterNodeRole" # replace with your cluster name
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "EKS_CLUSTER_NAME" # replace with your cluster name
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "EKS_CLUSTER_NAME" # replace with your cluster name
  userData: |
  sudo modprobe vhost_vsock vhost_net
```

## Deploying Cuttlefish

With the infrastructure setup, now you can run Cuttlefish Pods. Instead of running individual Pods, I chose to create a Deployment, which can be scaled up and down on demand. 

Cuttlefish Pods need access to `/dev/kvm`, which allows containers to access KVM functionality on the host system. These Pods also need to run in privileged mode to be able to access `/dev/kvm`. While this provides the necessary capabilities, it also poses security risks and should be used cautiously in production environments. Security measures should be taken to limit access to these Pods. 

Here's the manifest with a `nodeSelector`, which schedules the Pod on a `c6g.metal` instance:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: android-arm
  labels:
    app: android
spec:
  replicas: 1
  selector:
    matchLabels:
      app: android
  template:
    metadata:
      labels:
        app: android
    spec:
      nodeSelector:
        node.kubernetes.io/instance-type: c6g.metal
      containers:
      - name: android
        image: 12345678910.dkr.ecr.us-west-2.amazonaws.com/cuttlefish:graviton-v2 # Replace this with your image and tag
        command: ["/opt/cuttlefish-android/bin/launch_cvd"]
        args:
        - "--cpus"
        - "4"
        - "--memory_mb"
        - "4096"
        securityContext:
          privileged: true
        env:
        - name: HOME
          value: "/opt/cuttlefish-android"
        volumeMounts:
        - name: kvm
          mountPath: /dev/kvm
      volumes:
      - name: kvm
        hostPath:
          path: /dev/kvm
```

Once you deploy this manifest, you'll have an instance of Cuttlefish Android running in your cluster. 

## Connecting to a Virtual Device

Once a Cuttlefish Pod is running, you can connect to it using `adb` or WebRTC. 

While you can connect to the device using port forwarding, it's not going to be a smooth experience from a performance standpoint. Connecting to a remote virtual device is sensitive to network latency. The farther you are from the Pod, the worse will be your experience. 

Nonetheless, port forwarding is still useful for troubleshooting and when your machine and the Pod are on different networks. To create a port forwarding, run:

```sh
kubectl port-forward deployments/android-arm 6520
```

In another terminal window, connect to the virtual device using `adb`:

```sh
adb connect localhost:6520
```

Now, you can interact with the device. For instance, to open a shell connection, run:

```sh
adb shell
```

![Figure 3. Accessing Android shell using adb shell](carbon237432984.webp)

### Direct Connection

The connection provided by kubectl port forwarding will not be fast enough for debugging. It's best to have a direct connection from your machine to the Pod. Since all Pods in EKS get a VPC IP address, you can connect directly to the Pod as long as you can reach a Pod's IP address. 

For example, I created a Windows EC2 instance in the same VPC as my Kubernetes cluster. From this instance, I can directly access the Pod. My Android Pod's IP is 192.168.178.175. I can go to https://<POD's IP>:8443 to connect to the device over WebRTC. 

![Figure 4. Connecting to the virtual device using WebRTC.](1829a3e6e5b375c51cc389fe1e6be9eb3a5479bb.webp)

Having direct connectivity from your machine to the Pod is a luxury not every environment can afford. In most organizations, developer machines and Kubernetes clusters are in separate networks. In these scenarios, you'll have to utilize a Transit Gateway to be able to connect to a Pod directly. 

## Scaling Virtual Devices

The benefit of this setup is that you can easily go from one virtual device to hundreds of virtual devices without worrying about the underlying infrastructure. For instance, I can create another virtual device by scaling the deployment:

```sh
kubectl scale deployment android-arm --replicas 2
```

## Determining Pod Addresses is a Problem

A downside of this implementation is that developers must know the IP address of the virtual device's Pod. This problem is more accentuated in environments where developers don't have access to the Kubernetes cluster. 

Since, Pod IP addresses are not static, there are several challenges that are yet to be solved:
- Pod IP addresses can change when Pods are rescheduled or restarted, making it difficult for developers to maintain consistent connections to the virtual devices.
- Developers may need to update their configurations with new IP addresses, which is time-consuming and error-prone.

I am still exploring options like a VPN, [mirrord](https://mirrord.dev), an Ingress (for WebRTC only.) If you have a suggestion, I'd love to know. 

You can always create an internal load balancer (NLB) for every developer Pod. However, it comes with additional cost. In this implementation, every user has their own virtual device (backed by a Deployment with replicas=1). For instance, developerA.myorg.com routes to a Pod dedicated to DeveloperA. Should DeveloperA's Pod fail and get restarted, she won't need to determine the IP address of the new Pod.

![Figure 5. Using an internal NLB to route traffic to user Pods](Running%20Android%20on%20Kubernetes-1758418348117.webp)

## Turn Servers

**Update:** [Turn servers](https://github.com/google/android-emulator-container-scripts/blob/master/js/turn/README.MD) are the perfect solution for exposing devices on private networks. Here's a [Medium post](https://medium.com/@lemonchoismarceau/running-concurent-android-cuttlefish-jobs-webrtc-connection-08d79a1303dc) that explains this.

## Conclusion

Using Cuttlefish with Kubernetes offers a scalable implementation for Android development and testing workflows. It allows you to maximize hardware utilization, especially when there's a need to run multiple virtual Android devices. This architecture also gives you full control over your virtual devices. You can customize the device to suit your specific needs. 

However, there are still challenges to address, particularly in terms of Pod IP address management and developer access. There's still room for improvement when it comes to device discovery. 

In spite of these challenges, the combination presents a promising approach for teams looking to streamline Android development. 

