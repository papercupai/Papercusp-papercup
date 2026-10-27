---
rel_path: "evidence/tsc-fire58-current-metadata-correlation-20261025-v1.json"
updated_at: 1792898614710
_body: "content"
---

{
  "scope": "metadata-only; no compiler execution",
  "single": {
    "requestId": "059d154b-6f6d-4508-b596-c23eb72fcf6e",
    "correlationMatches": true,
    "identityMatches": true,
    "serviceSourceSha256": "2911e7f97e2be6caba5e8c13340b746c9d69296d40a9367ac29b48f500c7575c",
    "daemon": {
      "pid": 510905,
      "startedAt": 1792871101496
    }
  },
  "concurrentRequestIds": [
    "61ecab8e-a906-4baa-ad0c-0ac1980d3f8e",
    "9b3d1934-4ddf-46b7-8820-704edc285587",
    "0f329385-b2c8-4db5-b418-221b2f75ee62",
    "e9b0b686-f418-4472-b548-cc0bccdc578c",
    "3d417926-c239-462a-a160-63d6aa9fc519",
    "6d098813-0468-4055-9eea-dfdc47e1442f",
    "7b46eba0-e69e-42d0-88f6-d87988ddd642",
    "0ed178d8-e2f5-440f-b2fd-49d973e8e414"
  ],
  "concurrentObservation": "Each response request ID and full identity matched its own caller; each ok true on same daemon; no compilation.",
  "limitations": "Metadata path bypasses compiler queue/refresh/check and cannot falsify historical mismatch during compile or source mutation. Original log path no longer exists; previous durable checkpoint/comment evidence remains.",
  "next": "Discriminate source/compiler/config drift from request misrouting on a real compiler response. Current client collapses correlation and full identity mismatches into one message; preserve failclosed checking and rootcause remains unmeasured."
}
