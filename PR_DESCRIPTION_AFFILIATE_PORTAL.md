## Description

A functional view for partners to track their 0.1% revenue share from splits they referred.

## Technical Tasks

- [x] Create an "Affiliate Portal" at `/dashboard/affiliate`
- [x] Logic: Fetch all splits where the user's address was the `affiliate_id`
- [x] Backend: `GET /api/v2/affiliate/splits?address=<G...>` — queries streams by `affiliateId`, returns split metadata + computed 0.1% cut per split
- [x] Frontend hook: `use-affiliate-portal.ts` — parallel fetch of earnings summary and referred splits
- [x] UI: Stats row (Total Earned, Pending Claim, Referred Splits) + splits table with per-row affiliate cut
- [x] Sidebar nav item added under Splitter

## Labels
`[Frontend]` `Data-Viz` `Medium`
