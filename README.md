# ChatZoo OpenClaw Plugin

A real-time event-driven channel plugin that connects OpenClaw to the ChatZoo iOS app backend through `llm-gateway`. Replaces RPC-based communication with a webhook-based event architecture.

## Features

- **Inbound messaging**: Receive messages from ChatZoo iOS app via webhook
- **Outbound delivery**: Two-phase message delivery (in-app streaming + FCM push fallback)
- **Event forwarding**: Bidirectional event propagation (cron results, heartbeats, agent status)
- **Security**: HMAC-SHA256 signature verification for all webhook calls
- **Resilience**: Automatic retry with exponential backoff for failed deliveries

## Architecture

### Communication Flow

```
ChatZoo iOS App
       ↓
   llm-gateway
       ↓ (webhook)
    OpenClaw
   (plugin)
       ↓ (HTTP POST)
   llm-gateway
       ↓
    App & FCM
```

### Plugin Responsibilities

1. **Channel Registration**: Implements OpenClaw's `createChatChannelPlugin` interface
2. **Webhook Handlers**:
   - `POST /webhook/chatzoo` — Inbound messages (user → OpenClaw)
   - `POST /webhook/chatzoo/events` — Inbound events (gateway → OpenClaw)
3. **Outbound Delivery**: Sends completed responses back to the gateway
4. **Event Forwarding**: Forwards cron results and heartbeats to the gateway

## Configuration

### Required Fields

In OpenClaw's gateway config (`config.yaml` or `.env`):

```yaml
channels:
  chatzoo:
    # Shared secret with llm-gateway for HMAC verification
    hookToken: "your-secret-token"

    # llm-gateway base URL (e.g., https://llm-gateway-xxx.run.app)
    gatewayUrl: "https://your-gateway-url"

    # Optional: timeout for in-app delivery attempts (ms)
    deliveryTimeoutMs: 3000 # default
```

### Installation

1. Add to your OpenClaw plugins:

   ```bash
   cd /path/to/openclaw-gateway
   npm install @myorg/openclaw-chatzoo
   ```

2. Configure in gateway `config.yaml`:

   ```yaml
   plugins:
     enabled: ["chatzoo"]
     entries:
       chatzoo:
         config:
           gatewayUrl: "https://your-gateway-url"
           hookToken: "${CHATZOO_HOOK_TOKEN}"
   ```

3. Set environment variable:
   ```bash
   export CHATZOO_HOOK_TOKEN="shared-secret"
   ```

## API Reference

### Inbound: POST /webhook/chatzoo

**Authentication**: HMAC-SHA256 signature in `x-hook-signature` header

**Request Body**:

```json
{
  "conversationId": "string",
  "message": "string",
  "userId": "string"
}
```

**Response**:

```json
{
  "ok": true
}
```

**Error Responses**:

- `401` — Invalid signature or missing authentication
- `400` — Missing required fields or invalid JSON
- `500` — Internal server error

### Outbound: POST /v1/computer/delivery/message

**Purpose**: Attempt in-app delivery when the iOS app has an open connection

**Headers**:

```
Content-Type: application/json
x-hook-token: <hookToken>
```

**Body**:

```json
{
  "threadId": "string",
  "messageId": "string",
  "content": "string",
  "timestamp": "ISO8601"
}
```

**Expected Response**: `200 OK` if app is connected, otherwise timeout/error

### Outbound: POST /v1/computer/notify

**Purpose**: Persist message and send FCM push after in-app delivery times out

**Headers**:

```
Content-Type: application/json
x-hook-token: <hookToken>
```

**Body**:

```json
{
  "threadId": "string",
  "messageId": "string",
  "content": "string",
  "timestamp": "ISO8601",
  "sendPushNotification": boolean
}
```

### Events: POST /webhook/chatzoo/events

**Purpose**: Receive or view outbound events forwarded to the gateway

**Supported Event Types**:

```typescript
type ChatzooEvent =
  | {
      type: "cron.executed";
      jobId: string;
      jobName: string;
      result: string;
      executedAt: string;
    }
  | {
      type: "heartbeat.ping";
      instanceId: string;
      status: "healthy" | "degraded";
      timestamp: string;
    }
  | {
      type: "task.updated";
      taskId: string;
      status: string;
      progress?: number;
    }
  | {
      type: "agent.status.changed";
      agentId: string;
      status: string;
    };
```

## Development

### Project Structure

```
extensions/chatzoo/
├── package.json              # npm metadata + openclaw.channel
├── openclaw.plugin.json      # Plugin manifest with config schema
├── tsconfig.json
├── README.md                 # This file
├── index.ts                  # defineChannelPluginEntry (full runtime)
├── setup-entry.ts            # defineSetupPluginEntry (lightweight)
└── src/
    ├── channel.ts            # ChannelPlugin implementation
    ├── client.ts             # Runtime store
    ├── inbound.ts            # Webhook handler
    ├── outbound.ts           # Delivery adapter
    └── events.ts             # Event forwarding
```

### Building

```bash
npm run typecheck     # TypeScript validation
npm run test          # Run tests (if configured)
```

### Testing

1. **Webhook Signature Verification**:

   ```bash
   # See tests in src/inbound.test.ts
   npm test
   ```

2. **Local Gateway Testing**:
   Use `ngrok` or similar to expose localhost:
   ```bash
   ngrok http 3000
   # Set hookToken + gatewayUrl in OpenClaw config
   ```

## Security

### HMAC-SHA256 Verification

All webhook requests include an `x-hook-signature` header:

```
x-hook-signature: sha256=<hex-digest>
```

The plugin verifies:

1. Signature is present
2. Signature matches HMAC-SHA256(body, hookToken)
3. Signature length matches expected digest length (timing-safe comparison)

### Token Handling

- DO NOT log the `hookToken` in plaintext
- Use environment variables or secure secret management
- Rotate tokens periodically
- Keep the gateway instance and plugin in sync

## Troubleshooting

### Plugin fails to load

**Error**: `plugin manifest requires configSchema`

**Cause**: The `openclaw.plugin.json` manifest is missing or has invalid `configSchema`

**Fix**:

1. Ensure `openclaw.plugin.json` exists in plugin root
2. Verify `configSchema` is a valid JSON Schema object
3. Check for duplicate schemas in `package.json` (remove if found)

### Messages not being delivered

**Check**:

1. Verify `hookToken` is set correctly in both plugin config and gateway config
2. Ensure `gatewayUrl` is reachable (test with `curl`)
3. Check OpenClaw logs for delivery errors
4. Verify iOS app has an active connection (check gateway heartbeat)

### Signature verification fails

**Check**:

1. Confirm same `hookToken` on both sides
2. Verify request body is not modified before verification
3. Check for encoding issues (UTF-8)
4. Ensure header name is exactly `x-hook-signature`

## Migration from RPC

If migrating from an RPC-based setup:

1. Keep the old gateway running while the plugin is deployed
2. Update the iOS app to use the new webhook endpoint
3. Run both in parallel to verify message flow
4. Gradually migrate users to the new plugin
5. Decommission the old RPC endpoint

## OpenClaw SDK Reference

- **Plugin Entry**: [`defineChannelPluginEntry`](https://docs.openclaw.ai/plugins/sdk-entrypoints)
- **Channel Plugin**: [`createChatChannelPlugin`](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- **SDK Overview**: https://docs.openclaw.ai/plugins/sdk-overview
- **Manifest Reference**: https://docs.openclaw.ai/plugins/manifest

## Contributing

When contributing to this plugin:

1. Follow [OpenClaw Plugin Guidelines](https://docs.openclaw.ai/plugins/building-plugins)
2. Ensure all imports use the public `openclaw/plugin-sdk/*` paths
3. Add tests for new webhook handlers
4. Document API changes in this README
5. Run `npm run typecheck` before submitting PRs

## License

See [main ChatZoo repository](https://github.com/yourusername/chatzoo) for license terms.
