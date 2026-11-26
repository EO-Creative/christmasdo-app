# Christmas Night Out Venue Finder

A small React app that helps an office group shortlist potential venues for a Christmas night out. Search by a suggested town or city, enter the group size, and select any combination of activities, food, and drinks.

Results are Geoapify places within 5 km of the selected location. Selected venue types are combined as alternatives: a result can match one selected type and is not guaranteed to provide every part of the evening. Food searches focus on restaurants rather than cafés and food courts; obvious café and fast-food brands or classifications are filtered unless the place also matches a selected activity or drinks category. Listings with a numeric capacity below the submitted group size are omitted, and results with known suitable capacities rank ahead of unknown-capacity places. These are practical heuristics, not a group-booking guarantee.

Address, phone, website, and capacity information may be missing, incomplete, or out of date. Confirm details and availability with venues directly. Place lookup is powered by [Geoapify](https://www.geoapify.com/); map links open [OpenStreetMap](https://www.openstreetmap.org/copyright).

## Requirements

- Node.js 22.6 or newer (the test command uses Node's built-in TypeScript stripping).
- A free [Geoapify account and API key](https://myprojects.geoapify.com/) are required.

## Run locally

Install dependencies and start the development server:

```bash
npm install
cp .dev.vars.example .dev.vars
# Add your Geoapify key to .dev.vars
npm run dev
```

Open the local URL printed by Vite (normally [http://localhost:5173](http://localhost:5173)).
The `.dev.vars` file is ignored by Git and keeps the key on the server side; do not put it in React code or commit it.

## Verify and build

```bash
npm test
npm run lint
npm run build
```

## Data services and usage

- Location autocomplete and forward geocoding use Geoapify's [Geocoding API](https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/); nearby venue search uses its [Places API](https://apidocs.geoapify.com/docs/places/).
- The current Geoapify Free plan includes 3,000 shared credits per day and does not require a credit card. Autocomplete and geocoding each use 1 credit per request; venue search asks Geoapify for up to 100 nearby candidates (up to 5 credits) so the app can remove unsuitable matches before returning at most 20. Autocomplete waits until at least three characters have been typed and debounces requests.
- Geoapify's credit allowances and prices can change. Review the [current pricing](https://www.geoapify.com/pricing/) and usage in your Geoapify account; no Google Maps service is used.
- Overpass is an API for querying OpenStreetMap database objects; it is not itself a map display provider. The earlier implementation relied on a public shared Overpass server, which was returning overload errors. This app now uses Geoapify for location and venue search, while map links still open OpenStreetMap.
- The Worker reads `GEOAPIFY_API_KEY` from `.dev.vars` during local development. For deployment, configure it as a Worker secret with `npx wrangler secret put GEOAPIFY_API_KEY`; never expose the key in client-side code or commit a real key.
- The search radius is 5 km. Place coverage, category labels, and capacity details depend on available map data; café/fast-food and brand-name checks are deliberately conservative and can still miss a poor fit or filter an unusual match. Temporary provider failures are shown as errors rather than empty results.

## Deploy

Build and deploy to Cloudflare Workers using the configured Wrangler project. Set the Worker secret before relying on search in production:

```bash
npm run build
npm run deploy
# Configure the key after the first deployment (or update it at any time)
npx wrangler secret put GEOAPIFY_API_KEY
```
