# Self-Hosted LiveKit Stack

This folder contains the minimum self-hosted deployment scaffold for this portal:

- `docker-compose.yml`
- `livekit.yaml`

## What you need before starting

- A public host with UDP open for `50000-50100`
- A public DNS name for LiveKit, for example `livekit.example.com`
- A reverse proxy or load balancer terminating HTTPS/WSS for the LiveKit signaling endpoint

## Ports

- `7880/tcp`: LiveKit HTTP/WebSocket signaling behind your reverse proxy
- `7881/tcp`: LiveKit RTC over TCP fallback
- `50000-50100/udp`: RTC media
- `5349/tcp`: TURN over TLS, when explicitly enabled

## Start

```bash
cd infra/video
docker compose up -d
```

## Pair it with the portal

1. Copy `livekit.yaml.example` to ignored runtime file `livekit.yaml`, then set a real API secret.
2. Run the token gateway in `server/video-gateway`.
3. Point the frontend to that gateway with `VITE_VIDEO_API`.
4. Set `LIVEKIT_URL` in the gateway to your public `wss://` LiveKit endpoint.

## Operational notes

- `network_mode: host` is intentional. LiveKit recommends host networking for production-like performance.
- Redis is exposed only on `127.0.0.1:6379` so host-networked LiveKit can reach it without making Redis public.
- The embedded TURN server is disabled by default so LiveKit starts without placeholder certificates. To enable it, set `turn.enabled: true`, configure a public TURN domain, mount valid TLS cert/key files in `infra/video/certs`, and add their container paths to `livekit.yaml`.
- This repo does not contain a production auth backend. The included gateway is suitable for local integration and internal demos until you connect it to server-side auth.
