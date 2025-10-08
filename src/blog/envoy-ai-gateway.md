---
title: "An Introduction to Envoy AI Gateway"
date: 2025-10-08
layout: "post.njk"
description: "Envoy AI Gateway deployment guide for Kubernetes: OpenAI-compatible API gateway with AWS Bedrock integration, token-aware rate limiting, autoscaling, and observability."

---

# An Introduction to Envoy AI Gateway

Organizations deploying AI applications face a fundamental challenge: no single model serves all needs. Developers may choose Claude for long-context analysis, OpenAI for reasoning tasks, and Llama for cost-sensitive workloads. The problem is that each model provider uses different APIs. Without centralized control, teams can't easily switch providers, get visibility into utilization, or enforce quotas.

*Envoy AI Gateway* (EAIG) is an open source project that solves this challenge by providing a single, scalable OpenAI-compatible endpoint that routes to any provider. It gives Platform teams cost controls and observability, while developers never touch provider-specific SDKs.

Built on top of Envoy Gateway, EAIG specifically designed for handling LLM traffic. It acts as a centralized access point for managing and controlling access to various AI models within an organization.

When using EAIG, your applications call a single OpenAI-compatible endpoint. It acts as proxy between the developer using the model and the model provider. It is an abstraction that enables you to switch from Bedrock Claude to Bedrock Llama to self-hosted models to OpenAI, all without touching application code. 


![Envoy provides a unified gateway for consuming LLMs from different providers](Envoy-AI-Gateway-1759853507846.webp)

Besides using model providers, you can also self-host LLMs in your Kubernetes cluster. Self-hosting gives you more control over model deployment, data privacy, and infrastructure costs.

EAIG key features:
- Rate limiting based on tokens
- Automatic route to fallback secondary model providers 
- AI-specific observability [^1]

## Recap of Envoy Gateway Fundamentals

If you're already familiar with Envoy Gateway, you can skip this section. 

As EAIG builds on top of the standard Kubernetes Gateway API and Envoy Gateway extensions, it's necessary to familiarize yourself with the underlying Envoy Gateway primitives: 
- **GatewayClass** - Defines which controller manages the Gateway. EAIG uses the same GatewayClass as Envoy Gateway.
- **Gateway** - The entry point for traffic. A Gateway resource defines listeners (HTTP/HTTPS ports). When you create a Gateway, Envoy Gateway deploys the actual Envoy proxy pods and a corresponding Kubernetes Service (typically a LoadBalancer). This is like a Network Load Balancer (although technically you'd still need to attach an NLB to an Envoy Gateway to accept traffic that's external the Kubernetes cluster.)
- **HTTPRoute** - The instruction for routing traffic HTTP based on hostnames, paths, or headers. Conceptually, this is similar to ingress rules or listener rules in ALB. 
- [Backend](https://gateway.envoyproxy.io/contributions/design/backend/) - A Kubernetes Service or an external endpoint. 
- [BackendTrafficPolicy](https://gateway.envoyproxy.io/contributions/design/backend-traffic-policy/) - Configures connection behavior like timeouts, retries, and rate limiting of an HTTPRoute. 
- [ClientTrafficPolicy](https://gateway.envoyproxy.io/contributions/design/client-traffic-policy/) - Configures how the Envoy proxy server behaves with downstream clients. 
- [EnvoyExtensionPolicy](https://gateway.envoyproxy.io/contributions/design/envoy-extension-policy/) - A way to extend Envoy's traffic processing capabilities. 

## Concepts

EAIG introduces the following CRDs:
- AIGatewayRoute - Defines unified API and routing rules for AI traffic
- AIServiceBackend - Represents individual AI service backends like Bedrock
- BackendSecurityPolicy - Configures authentication for backend access
- BackendTLSPolicy - Defines TLS parameters for backend connections

![](Pasted-image-20250930162801.webp)

Here's the high level request flow [^2]:
- The request comes into Envoy AI Gateway.
- Authorization filter is applied for checking if the user or account is authorized to access the model.
- An AI service backend is identified by matching request headers such as model name.
- The request is translated in to the API schema of the AI service backend.
- AI service authentication policy is applied based on the AI service backend:
    - AWS requests are signed and credentials are injected for AWS Bedrock authentication.
- Rate limiting filter is applied for request based usage tracking.
- Envoy routes the request to the specified AI service backend.
- Upon receiving the response from the AI service, the token usage limit is reduced by extracting the usage fields of the chat completion response.
    - the rate limit is enforced on the subsequent request.
- The response is sent back to the client. 

![](Envoy-AI-Gateway-1759459995185.webp)



![The routing flow from CRD perspective: Client Request → Gateway (Listener) → AIGatewayRoute (header match) → AIServiceBackend (schema translation) → Backend (an LLM running in Kubernetes or Amazon Bedrock](Envoy-AI-Gateway-1759413253935.webp)

### AIGatewayRoute

The AIGatewayRoute routes to one or more AIServiceBackends. When you create an AIGatewayRoute, EAIG creates an HTTPRoute and HTTPRouteFilter (for URL rewriting).

EAIG adds governance, reliability, and observability over AI traffic. It tracks input and output tokens, allowing administrators to define quotas and implement rate limiting. 

Besides routing traffic, it is also used to
- Specify the input API schema for client requests
- Manage request/response transformations between different API schemas
- Track LLM token usage

Here's an example of an AIGatewayRoute that exposes two models (Claude and GPT-OSS from Bedrock) while tracking token usage:

```yaml
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: AIGatewayRoute
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  parentRefs:
    - name: eaig-bedrock
      kind: Gateway
      group: gateway.networking.k8s.io
  rules:
    - matches:
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: anthropic.claude-3-sonnet-20240229-v1:0
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: openai.gpt-oss-120b-1:0
      backendRefs:
        - name: eaig-bedrock
    # The following metadata keys are used to store the costs from the LLM request.
  llmRequestCosts:
    - metadataKey: llm_input_token
      type: InputToken
    - metadataKey: llm_output_token
      type: OutputToken
    - metadataKey: llm_total_token
      type: TotalToken
    # This configures the token limit based on the CEL expression.
    # For a demonstration purpose, the CEL expression returns 100000000 only when the input token is 3,
    # otherwise it returns 0 (no token usage).
    - metadataKey: llm_cel_calculated_token
      type: CEL
      cel: "input_tokens == uint(3) ? 100000000 : 0"
```

#### External Processor

ExtProc (External Processing server) runs as a sidecar container alongside the Envoy proxy Pod. When a request hits the gateway, the gateway forwards ito the ExtProc. ExtProc manipulates headers and sends them back to the gateway. The gateway then sends the modified request to the upstream service (like Bedrock).  

ExtProc performs three functions:
1. Schema translation - Converts backend APIs to Open AI APIs. 
2. Credential injection - Retrieves backend credentials from BackendSecurityPolicy and injects them into outgoing requests. For AWS Bedrock, this means adding AWS SigV4 signature headers.
3. Token counting - After receiving the response from Bedrock, ExtProc extracts token usage from the response. 

![External processing for request headers](Envoy-AI-Gateway-1759452788510.webp)

#### BackendTrafficPolicy

A BackendTrafficPolicy is used to rate-limit users for a particular AIGatewayRoute. Unlike traditional rate limiting where each request costs "1", token-based limits track the number of input tokens, output tokens, or a weighted combination of both.[^3]

When Envoy AI Gateway receives a request, the ExtProc server extracts token counts from the LLM response and stores them in Envoy's dynamic metadata. The BackendTrafficPolicy then deducts these token counts from the budget.

For example, you can limit any user to 1000 input tokens per hour. The policy uses header values to determine rate limit budgets, so you can also limit by team, application, or any custom identifier your clients send.

### AIServiceBackend

AIServiceBackend represents a single AI service backend for AIGatewayRoute. 

It represents a single AI service backend (like Bedrock) that handles traffic with a specific API schema. It:
- defines the output API schema the backend expects
- references a Kubernetes Service or Envoy Gateway Backend
- reference a BackendSecurityPolicy for authentication

```yaml
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: AIServiceBackend
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  schema:
    name: AWSBedrock
  backendRef:
    name: eaig-bedrock
    kind: Backend
    group: gateway.envoyproxy.io
```

An AIServiceBackend references a Backend that's hosting the LLM. It can be a service like Bedrock or a Kubernetes Service. 

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  endpoints:
    - fqdn:
        hostname: bedrock-runtime.us-west-2.amazonaws.com
        port: 443
```

### BackendSecurityPolicy

BackendSecurityPolicy configures authentication methods for backend access. In case of Amazon Bedrock, it handles AWS SigV4 signing. 

Currently, you must reference a Kubernetes Secret containing AWS API credentials. For production environments, using IAM roles (Pod Identity on EKS) is more secure than static credentials. However, Envoy AI Gateway currently requires a Secret reference even when using IAM roles. You can create a Secret with placeholder values that will be ignored in favor of the Pod's IAM role.

```yaml
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: BackendSecurityPolicy
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  targetRefs:
    - group: aigateway.envoyproxy.io
      kind: AIServiceBackend
      name: eaig-bedrock
  type: AWSCredentials
  awsCredentials:
    region: us-west-2
    credentialsFile:
      secretRef:
        name: eaig-bedrock
```

## Deploying EAIG on an Amazon EKS Cluster

This walkthrough deploys Envoy AI Gateway on Amazon EKS to expose two LLMs from Amazon Bedrock. It is configured with token-based rate limiting enforced per user. Each user is identified by the `x-user-id` header and receives independent token budgets. The gateway handles AWS authentication via IAM roles. It also tracks token usage through Prometheus metrics.

Before proceeding ensure you've deployed Envoy Gateway in your cluster. Deploy Envoy Gateway if you don't have it installed in your cluster:

```sh
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v0.0.0-latest \
  --set config.envoyGateway.provider.kubernetes.deploy.type=GatewayNamespace \
  -n envoy-gateway-system \
  --create-namespace
```

Deploy Envoy AI Gateway using Helm:

```sh
helm upgrade -i aieg oci://docker.io/envoyproxy/ai-gateway-helm \
  --version v0.0.0-latest \
  --namespace envoy-ai-gateway-system \
  --set "controller.image.tag=536e1f3bf8e674669825fc41c8b2f06f3c803235" \
  --create-namespace
```

Set Gateway Controller image to: `docker.io/envoyproxy/ai-gateway-controller:536e1f3bf8e674669825fc41c8b2f06f3c803235` because the latest is broken.

After installing Envoy AI Gateway, apply the AI Gateway-specific configuration to Envoy Gateway and restart the deployment:

```bash
kubectl apply -f https://raw.githubusercontent.com/envoyproxy/ai-gateway/main/manifests/envoy-gateway-config/redis.yaml

kubectl apply -f https://raw.githubusercontent.com/envoyproxy/ai-gateway/main/manifests/envoy-gateway-config/config.yaml

kubectl apply -f https://raw.githubusercontent.com/envoyproxy/ai-gateway/main/manifests/envoy-gateway-config/rbac.yaml

kubectl rollout restart -n envoy-gateway-system deployment/envoy-gateway
```

Create an IAM Policy that allows access to Amazon Bedrock `InvokeModel` and `ListFoundationModels` API:

```sh
aws iam create-policy \
  --policy-name EnvoyAIGatewayBedrockAccessPolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "bedrock:InvokeModel",
          "bedrock:ListFoundationModels"
        ],
        "Resource": "*"
      }
    ]
  }'
```

Create an IAM Role:

```sh
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
cat >trust-relationship.json <<EOF
{
    "Version": "2012-10-17",		 	 	 
    "Statement": [
        {
            "Sid": "AllowEksAuthToAssumeRoleForPodIdentity",
            "Effect": "Allow",
            "Principal": {
                "Service": "pods.eks.amazonaws.com"
            },
            "Action": [
                "sts:AssumeRole",
                "sts:TagSession"
            ]
        }
    ]
}
EOF

aws iam create-role \
  --role-name EnvoyAIGatewayBedrockAccessRole \
  --assume-role-policy-document file://trust-relationship.json 
  
aws iam attach-role-policy --role-name EnvoyAIGatewayBedrockAccessRole \
  --policy-arn=arn:aws:iam::${AWS_ACCOUNT_ID}:policy/EnvoyAIGatewayBedrockAccessPolicy
```

Create a Pod Identity Mapping:

```sh
CLUSTER_NAME=Socrates
BEDROCK_ROLE_ARN=arn:aws:iam::${AWS_ACCOUNT_ID}:role/EnvoyAIGatewayBedrockAccessRole

aws eks create-pod-identity-association \
  --cluster-name $CLUSTER_NAME \
  --namespace envoy-gateway-system \
  --service-account ai-gateway \
  --role-arn $BEDROCK_ROLE_ARN
```

Before deploying the Gateway, ensure that you've enabled the following models in Bedrock:
- openai.gpt-oss-120b-1:0
- anthropic.claude-3-sonnet-20240229-v1:0

Create Envoy AI Gateway resources:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eaig-bedrock
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef: 
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: envoy-ai-gateway
    namespace: envoy-gateway-system
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: envoy-ai-gateway
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyDeployment:
        container:
          resources: {}
      envoyServiceAccount:
        name: ai-gateway
      envoyService:
        type: ClusterIP
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  gatewayClassName: eaig-bedrock
  listeners:
    - name: http
      protocol: HTTP
      port: 80
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: client-buffer-limit
  namespace: default
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: eaig-bedrock
  connection:
    bufferLimit: 50Mi
---
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: AIGatewayRoute
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  parentRefs:
    - name: eaig-bedrock
      kind: Gateway
      group: gateway.networking.k8s.io
  rules:
    - matches:
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: anthropic.claude-3-sonnet-20240229-v1:0
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: openai.gpt-oss-120b-1:0
      backendRefs:
        - name: eaig-bedrock
    # The following metadata keys are used to store the costs from the LLM request.
  llmRequestCosts:
    - metadataKey: llm_input_token
      type: InputToken
    - metadataKey: llm_output_token
      type: OutputToken
    - metadataKey: llm_total_token
      type: TotalToken
    # This configures the token limit based on the CEL expression.
    # For a demonstration purpose, the CEL expression returns 100000000 only when the input token is 3,
    # otherwise it returns 0 (no token usage).
    - metadataKey: llm_cel_calculated_token
      type: CEL
      cel: "input_tokens == uint(3) ? 100000000 : 0"
---
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: BackendSecurityPolicy
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  targetRefs:
    - group: aigateway.envoyproxy.io
      kind: AIServiceBackend
      name: eaig-bedrock
  type: AWSCredentials
  awsCredentials:
    region: us-west-2
    credentialsFile:
      secretRef:
        name: eaig-bedrock
---
apiVersion: aigateway.envoyproxy.io/v1alpha1
kind: AIServiceBackend
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  schema:
    name: AWSBedrock
  backendRef:
    name: eaig-bedrock
    kind: Backend
    group: gateway.envoyproxy.io
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  endpoints:
    - fqdn:
        hostname: bedrock-runtime.us-west-2.amazonaws.com
        port: 443
---
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: eaig-bedrock
  namespace: default
spec:
  targetRefs:
    - group: 'gateway.envoyproxy.io'
      kind: Backend
      name: eaig-bedrock
  validation:
    wellKnownCACertificates: "System"
    hostname: bedrock-runtime.us-west-2.amazonaws.com
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: eaig-bedrock-ratelimit-policy
  namespace: default
spec:
  # Applies the rate limit policy to the gateway.
  targetRefs:
    - name: eaig-bedrock
      kind: Gateway
      group: gateway.networking.k8s.io
  rateLimit:
    type: Global
    global:
      rules:
        # This configures the input token limit, and it has a different budget than others,
        # so it will be rate limited separately.
        - clientSelectors:
            - headers:
                # Have the rate limit budget be per unique "x-user-id" header value.
                - name: x-user-id
                  type: Distinct
          limit:
            # Configures the number of "tokens" allowed per hour, per user.
            requests: 10
            unit: Hour
          cost:
            request:
              from: Number
              # Setting the request cost to zero allows to only check the rate limit budget,
              # and not consume the budget on the request path.
              number: 0
            response:
              from: Metadata
              metadata:
                # This is the fixed namespace for the metadata used by AI Gateway.
                namespace: io.envoy.ai_gateway
                # Limit on the input token.
                key: llm_input_token

        # Repeat the same configuration for a different token type.
        # This configures the output token limit, and it has a different budget than others,
        # so it will be rate limited separately.
        - clientSelectors:
            - headers:
                - name: x-user-id
                  type: Distinct
          limit:
            requests: 10
            unit: Hour
          cost:
            request:
              from: Number
              number: 0
            response:
              from: Metadata
              metadata:
                namespace: io.envoy.ai_gateway
                key: llm_output_token

        # Repeat the same configuration for a different token type.
        # This configures the total token limit, and it has a different budget than others,
        # so it will be rate limited separately.
        - clientSelectors:
            - headers:
                - name: x-user-id
                  type: Distinct
          limit:
            requests: 10
            unit: Hour
          cost:
            request:
              from: Number
              number: 0
            response:
              from: Metadata
              metadata:
                namespace: io.envoy.ai_gateway
                key: llm_total_token

        # Repeat the same configuration for a different token type.
        # This configures the token limit based on the CEL expression.
        - clientSelectors:
            - headers:
                - name: x-user-id
                  type: Distinct
          limit:
            requests: 10
            unit: Hour
          cost:
            request:
              from: Number
              number: 0
            response:
              from: Metadata
              metadata:
                namespace: io.envoy.ai_gateway
                key: llm_cel_calculated_token
---
apiVersion: v1
kind: Secret
metadata:
  name: eaig-bedrock
  namespace: default
type: Opaque
stringData:
  # Replace this with your AWS credentials.
  credentials: |
    dummy-secret
---
```

### Testing

After deploying Envoy AI Gateway, we can call LLMs using Open AI APIs. For simplicity, we'll use curl to invoke the model. 

Get the Gateway's URL:

```sh
# Get the IP of the Gateway Service
kubectl get gateway/eaig-bedrock \
  -o jsonpath='{.status.addresses.value}'
```

Exec into a Pod running in your cluster. Then, use curl to send requests. Remove the `x-user-id` header if you don't want to be rate limited:

```bash
export GATEWAY_URL=<IP of Gateway Service>

curl -H "Content-Type: application/json" \
  -H "x-user-id: my-user-123" \
   -d '{
    "model": "anthropic.claude-3-sonnet-20240229-v1:0",
    "messages": [
      {
        "role": "user",
        "content": "Who was Aristotle? Tell it to me in less than 160 characters"
      }
    ]
  }'   $GATEWAY_URL/v1/chat/completions
```

Script to generate requests of varying sizes:

```sh
#!/bin/bash

export GATEWAY_URL=k8s-envoygat-envoydef-149225385c-0cf2a2e68ca526f5.elb.us-west-2.amazonaws.com

while true; do
  CHAR_COUNT=$((160 + RANDOM % 1068))
  
  echo "=== Request at $(date) - Requesting $CHAR_COUNT characters ==="
  curl -H "Content-Type: application/json" \
    -d "{
      \"model\": \"anthropic.claude-3-sonnet-20240229-v1:0\",
      \"messages\": [
        {
          \"role\": \"user\",
          \"content\": \"Who was Aristotle? Tell it to me in less than $CHAR_COUNT characters\"
        }
      ]
    }" \
    "$GATEWAY_URL/v1/chat/completions" \
    -v
  
  echo -e "\n--- Waiting 20 seconds ---\n"
  sleep 20
done
```

## Observability

Envoy AI Gateway exposes GenAI-specific metrics following the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). 

These metrics can be put into three main buckets:
- Token usage - Number of tokens processed
- Request duration - Generative AI server request duration such as time-to-last byte or last output token
- Target info - Metadata about the telemetry SDK

Here's a [Grafana dashboard](https://gist.github.com/realvz/13807b77e04c4b0a4a1c3f4288adf0f8) visualizing EAIG metrics.

![](Envoy-AI-Gateway-1759946358631.webp)

## Autoscaling Envoy AI Gateway

As your AI usage grows, a single Envoy proxy Pod may become a bottleneck, leading to increased latency, slower response times, or even request failures under high load. To handle this, you can use HPA to automatically scale the number of Envoy proxy pods based on resource utilization or custom metrics.

Under the hood, Envoy AI Gateway (EAIG) builds on Envoy Gateway, which manages the Envoy proxy deployment. The EnvoyProxy CRD supports HPA configuration directly through the `envoyHpa` field in its spec. This allows you to define scaling rules without manually creating an HPA resource. When configured, Envoy Gateway will generate and manage the HPA. 

Below is a configuration that scales Envoy proxy Pods based on a custom metric. Note that you'd need metrics-server and Prometheus adapter installed in your cluster. You'll also need to update Prometheus Adapter to expose the metric. 

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: envoy-ai-gateway
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyDeployment:
        container:
          resources: {}
      envoyServiceAccount:
        name: ai-gateway
      envoyService:
        type: ClusterIP
      envoyHpa:
        minReplicas: 1
        maxReplicas: 5
        metrics:
           - type: Pods
             metric:
               name: server_request_duration_seconds_avg
             target:
               type: AverageValue
               averageValue: "10"
```

Here's a sample Prometheus adapter query that calculates and exposes average server request latency:

```yaml
 - seriesQuery: 'gen_ai_server_request_duration_seconds_sum{kubernetes_namespace!="",kubernetes_pod_name!=""}'
      resources:
        overrides:
          kubernetes_namespace: {resource: "namespace"}
          kubernetes_pod_name: {resource: "pod"}
      name:
        matches: "gen_ai_server_request_duration_seconds_sum"
        as: "server_request_duration_seconds_avg"
      metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>) / sum(gen_ai_server_request_duration_seconds_count{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

It is best to scale Envoy on either CPU metrics or listener metrics. Check out [Envoy documentation](https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/stats) to find out the appropriate metric based on your usage type.


---

## Footnotes

[^1]: [ai-gateway/examples/access-log/basic.yaml at cd3f6d6ecb053b8448c35b3cf72e1395dd9fab4f · envoyproxy/ai-gateway · GitHub](https://github.com/envoyproxy/ai-gateway/blob/cd3f6d6ecb053b8448c35b3cf72e1395dd9fab4f/examples/access-log/basic.yaml)
[^2]: [Data Plane and Traffic Flow \| Envoy AI Gateway](https://aigateway.envoyproxy.io/docs/concepts/architecture/data-plane#1-request-path)
[^3]: [ai-gateway/examples/token\_ratelimit/token\_ratelimit.yaml at v0.3.0 · envoyproxy/ai-gateway · GitHub](https://github.com/envoyproxy/ai-gateway/blob/v0.3.0/examples/token_ratelimit/token_ratelimit.yaml)