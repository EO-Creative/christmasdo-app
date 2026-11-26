# Christmas Night Out Venue Finder

A small React app that helps an office group shortlist potential venues for a Christmas night out. Search by a suggested town or city, enter the group size, choose a search radius, and select any combination of activities, food, and drinks.

Results are split into separate lists for each selected type, each containing up to 20 Geoapify places within the chosen 1, 2, 5, 10, or 20 km radius. This allows a popular category to have its own results rather than crowding out the others. Geoapify does not provide dependable customer ratings for these listings, so each list is ordered by listed capacity suitability and then distance; no rating is fabricated. Food searches focus on restaurants rather than cafés and food courts; obvious café and fast-food brands or classifications are filtered. Listings with a numeric capacity below the submitted group size are omitted. These are practical heuristics, not a group-booking guarantee.

Each completed search is saved as a snapshot and given a shareable URL. Anyone with the link can add/remove venues from the shared shortlist and vote on shortlisted venues; changes refresh automatically about every 30 seconds, or can be refreshed manually. The snapshot does not change when a provider's listings change; run a new search to create an updated share link.

Address, phone, website, and capacity information may be missing, incomplete, or out of date. Confirm details and availability with venues directly. Place lookup is powered by [Geoapify](https://www.geoapify.com/); map links open [OpenStreetMap](https://www.openstreetmap.org/copyright).

## Requirements

- Node.js 22.6 or newer (the test command uses Node's built-in TypeScript stripping).
- A free [Geoapify account and API key](https://myprojects.geoapify.com/) are required.
- Cloudflare D1 is used to persist shareable search snapshots and votes. Local development uses Wrangler's local D1 database; deploying requires creating a D1 database in your Cloudflare account.

## Run locally

Install dependencies and start the development server:

```bash
npm install
cp .dev.vars.example .dev.vars
# Add your Geoapify key to .dev.vars
npx wrangler d1 migrations apply christmasdo-db --local
npm run dev
```

Open the local URL printed by Vite (normally [http://localhost:5173](http://localhost:5173)).
The `.dev.vars` file is ignored by Git and keeps the key on the server side; do not put it in React code or commit it.
The Cloudflare Vite plugin also copies local variables to `dist/christmasdo_app/.dev.vars` for preview. Keep that ignored build directory private and never publish or upload it as a generic artifact.

## Verify and build

```bash
npm test
npm run lint
npm run build
```

## Data services and usage

- Location autocomplete and forward geocoding use Geoapify's [Geocoding API](https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/); nearby venue search uses its [Places API](https://apidocs.geoapify.com/docs/places/).
- The current Geoapify Free plan includes 3,000 shared credits per day and does not require a credit card. Autocomplete and geocoding each use 1 credit per request; each selected category gets an independent Places request for up to 100 nearby candidates (up to 5 credits per request, or 15 for all three categories) so filtering one type cannot hide another. Autocomplete waits until at least three characters have been typed and debounces requests.
- Geoapify's credit allowances and prices can change. Review the [current pricing](https://www.geoapify.com/pricing/) and usage in your Geoapify account; no Google Maps service is used.
- Overpass is an API for querying OpenStreetMap database objects; it is not itself a map display provider. The earlier implementation relied on a public shared Overpass server, which was returning overload errors. This app now uses Geoapify for location and venue search, while map links still open OpenStreetMap.
- The Worker reads `GEOAPIFY_API_KEY` from `.dev.vars` during local development. For deployment, configure it as a Worker secret with `npx wrangler secret put GEOAPIFY_API_KEY`; never expose the key in client-side code or commit a real key.
- The search radius is selected from 1, 2, 5, 10, or 20 km. Place coverage, category labels, and capacity details depend on available map data; café/fast-food and brand-name checks are deliberately conservative and can still miss a poor fit or filter an unusual match. Temporary provider failures are shown as errors rather than empty results.

## Shared searches and voting

- Search snapshots, shortlist membership, and votes are stored in D1. Share links are opaque random IDs; anyone who has a link can view and edit that search's shortlist.
- Voting uses a random browser identifier stored in local storage, not sign-in or verified identity. Votes are one-per-venue per browser profile and can be changed or removed; clearing local storage or using another browser creates another voting identity.
- Search links do not currently expire automatically. They remain in D1 until records are manually removed, and each new search creates a separate snapshot.
- The configured D1 ID in `wrangler.json` is a local-development placeholder. Before deploying, run `npx wrangler d1 create christmasdo-db`, replace the placeholder `database_id` with the ID Wrangler returns, then run `npx wrangler d1 migrations apply christmasdo-db --remote`. Cloudflare authentication is required for these remote steps.

## Deploy

Build and deploy to Cloudflare Workers using the configured Wrangler project. Set the Worker secret before relying on search in production:

```bash
npm run build
npx wrangler d1 migrations apply christmasdo-db --remote
npx wrangler secret put GEOAPIFY_API_KEY
npm run deploy
```
