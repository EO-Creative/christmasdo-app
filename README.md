# Christmas Night Out Venue Finder

A small React app that helps an office group shortlist potential venues for a Christmas night out. Describe the evening you have in mind, then set the location, group size, and search radius. The app suggests separate activity, food, and drinks searches; you can adjust the category choices before searching.

Results are split into separate lists for each selected type, each containing up to 20 Geoapify places within the chosen 1, 2, 5, 10, or 20 km radius. This allows a popular category to have its own results rather than crowding out the others. Geoapify does not provide dependable customer ratings for these listings, so each list is ordered by listed capacity suitability and then distance; no rating is fabricated. Food searches focus on restaurants rather than cafés and food courts; obvious café and fast-food brands or classifications are filtered. Listings with a numeric capacity below the submitted group size are omitted. These are practical heuristics, not a group-booking guarantee.

Each completed search is saved as a snapshot and given a shareable URL. The shared shortlist and its category-by-category votes appear before the search form on a shared link. Anyone with the link can add/remove venues from the shared shortlist and vote; each browser identity can select one shortlisted venue per selected category, and can change that choice. Changes refresh automatically about every 30 seconds, or can be refreshed manually. The snapshot does not change when a provider's listings change; run a new search to create an updated share link.

Address, phone, website, and capacity information may be missing, incomplete, or out of date. Confirm details and availability with venues directly. Place lookup is powered by [Geoapify](https://www.geoapify.com/); map links and the optional interactive map use [OpenStreetMap](https://www.openstreetmap.org/copyright).

## Conversational search

The prompt interpreter uses deterministic phrase matching, not an unrestricted language model. It recognizes common activity types and supported cuisine names (including Lebanese) and uses Geoapify's corresponding place categories to narrow those result lists. It also suggests the broad Activities, Food, and Drinks lists from phrases in the request; users can change those checkboxes before searching. Unrecognized wording does not invent a category.

Some preferences cannot be checked in the available map data. Indoor status, specific beer/wine menus, and budget or price range are called out as unverified, and results should be confirmed with venues. Search prompts are limited to 500 characters and saved in the shareable search snapshot; do not include personal or confidential details.

## Requirements

- Node.js 22.6 or newer (the test command uses Node's built-in TypeScript stripping).
- A free [Geoapify account and API key](https://myprojects.geoapify.com/) are required.
- Cloudflare D1 is used to persist shareable search snapshots and votes. Local development uses Wrangler's local D1 database; deployment uses the configured remote D1 database.

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
The configured database ID uses a separate local database from the previous placeholder ID. Old local-only snapshots are not migrated automatically.

## Verify and build

```bash
npm test
npm run lint
npm run build
```

## Data services and usage

- Location autocomplete and forward geocoding use Geoapify's [Geocoding API](https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/); nearby venue search uses its [Places API](https://apidocs.geoapify.com/docs/places/).
- The current Geoapify Free plan includes 3,000 shared credits per day and does not require a credit card. Autocomplete and geocoding each use 1 credit per request; each selected category gets an independent Places request for up to 100 nearby candidates (up to 5 credits per request, or 15 for all three categories) so filtering one type cannot hide another. Autocomplete waits until at least three characters have been typed and debounces requests.
- Conversational activity and cuisine matches narrow the corresponding independent Places request to supported Geoapify categories (for example, sports centres/halls or Lebanese restaurants). Generic searches still use the broad category list; indoor status, beverage menus, and prices are not verified.
- Geoapify's credit allowances and prices can change. Review the [current pricing](https://www.geoapify.com/pricing/) and usage in your Geoapify account; no Google Maps service is used.
- Search results default to the familiar category lists and can be switched to an interactive map. Activity, Food, and Drink markers have distinct colors; co-located venues share a marker that shows every applicable category, and selecting it reveals the venue cards and shortlist/vote actions.
- Interactive map tiles are requested from OpenStreetMap's public tile service only when Map view is opened. Attribution is shown on the map; tiles are a third-party service with its own usage policy and availability limits, and are not covered by Geoapify's free credits. Avoid bulk tile downloads or prefetching; list view remains available if map tiles cannot load.
- Overpass is an API for querying OpenStreetMap database objects; it is not itself a map display provider. The earlier implementation relied on a public shared Overpass server, which was returning overload errors. This app now uses Geoapify for location and venue search, while map links still open OpenStreetMap.
- The Worker reads `GEOAPIFY_API_KEY` from `.dev.vars` during local development. For deployment, configure it as a Worker secret with `npx wrangler secret put GEOAPIFY_API_KEY`; never expose the key in client-side code or commit a real key.
- The search radius is selected from 1, 2, 5, 10, or 20 km. Place coverage, category labels, and capacity details depend on available map data; café/fast-food and brand-name checks are deliberately conservative and can still miss a poor fit or filter an unusual match. Temporary provider failures are shown as errors rather than empty results.

## Shared searches and voting

- Search snapshots, shortlist membership, and category-specific votes are stored in D1. Share links are opaque random IDs; anyone who has a link can view and edit that search's shortlist.
- Voting uses a random browser identifier stored in local storage, not sign-in or verified identity. Ordinary page refreshes keep that ID, and the server enforces one selected venue per category for each supplied ID; however, a determined user can clear/change browser storage, use another browser/device, or call the API with another ID. This is a lightweight poll, not fraud-proof or identity-verified voting.
- Existing votes are migrated to their matching categories. If an old browser had voted for multiple venues in one category, the migration retains the newest vote (with a deterministic venue-ID tie-break) for that category.
- Search links do not currently expire automatically. They remain in D1 until records are manually removed, and each new search creates a separate snapshot.
- `wrangler.json` binds `DB` to the `christmasdo-db` database in the EO Creative Cloudflare account. Apply migrations with `npx wrangler d1 migrations apply christmasdo-db --remote` before deploying schema changes; remote operations require Cloudflare authentication. For another account, create a database there and replace `database_id` with its ID.

## Deploy

Build and deploy to Cloudflare Workers using the configured Wrangler project. The configured custom domain is `christmasdo.app`; update the route when deploying to another domain. Set the Worker secret before relying on search in production:

```bash
npm run build
npx wrangler d1 migrations apply christmasdo-db --remote
npx wrangler secret put GEOAPIFY_API_KEY
npm run deploy
```
