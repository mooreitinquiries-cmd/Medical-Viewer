# PACS Mirror Service

Per-seat PACS session mirror service for macexpansion.

## Run

```bash
npm run pacs:mirror
```

## Endpoints

- `GET /health`
- `GET /mirror/:officeSlug/:seatId` (creates/attaches seat and returns stream/control URLs)
- `WS /mirror/:officeSlug/:seatId/stream` (JPEG frame stream)
- `WS /mirror/:officeSlug/:seatId/control` (mouse/keyboard/scroll input)

## Auth

Provide `Authorization: Bearer <PACS_MIRROR_TOKEN>` or `?token=<PACS_MIRROR_TOKEN>`.
