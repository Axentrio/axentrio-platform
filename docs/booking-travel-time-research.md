# Google Maps Platform for travel-time-aware booking — primary-source research

**Written:** 2026-08-06. **All pages retrieved 2026-08-06.**

**What this is for.** We are deciding whether to build travel-time-aware appointment scheduling into
the booking engine: geocode a customer address, compute drive time from the previous appointment (or
a home base), and use that to accept or reject a slot. That design implies storing customer
`lat`/`lng` on booking rows and caching computed travel durations in Redis. This document establishes
what the Google APIs actually do, what they cost, and — most importantly — whether the storage design
is permitted by Google's terms.

**Source discipline.** Every claim below links to a first-party Google page (`developers.google.com`,
`cloud.google.com`) and nothing else. No blog posts, no Stack Overflow, no secondary write-ups.
Legal clauses are reproduced verbatim, not paraphrased. Where a primary source is silent, this
document says so in [Could not verify](#could-not-verify) rather than guessing. Two documents have
version dates that matter and are stated inline: the Google Maps Platform Terms of Service is
**"Last modified June 23, 2026"** and the Maps Service Specific Terms is **"Last modified June 10,
2026"**.

---

## BOTTOM LINE

- **No — we cannot store customer lat/lng on a booking row for the lifetime of the booking.** The
  Service Specific Terms cap it at **"up to 30 consecutive calendar days, after which Customer must
  delete the cached latitude and longitude values"** — separately for Geocoding (§6.3.1) and for
  Routes (§19.3). There *is* an indefinite-caching exception (§6.3.2) but it is narrow and our
  planned use almost certainly fails it (see §6). **`place_id` may be stored indefinitely** and is
  the correct durable key; treat lat/lng as a ≤30-day cache keyed off it.
- **Caching computed travel durations in Redis is *not expressly permitted*, at any TTL.** The ToS
  is default-deny (**"Customer will not cache Google Maps Content except as expressly permitted
  under the Maps Service Specific Terms"**) and the Routes API section of those terms permits
  caching *only* lat/lng — it never mentions duration or distance, unlike the Navigation Connect
  API section which explicitly does. This needs legal sign-off before we build it. See §6.
- **Cost per booking lookup:** Geocoding **$5.00 / 1,000 requests** = $0.005. Route Matrix is billed
  **per element** (origins × destinations): traffic-unaware **$5.00 / 1,000 elements** = $0.005/element;
  traffic-aware (`TRAFFIC_AWARE` or `TRAFFIC_AWARE_OPTIMAL`) bills the Pro SKU at **$10.00 / 1,000
  elements** = $0.01/element. A lookup that geocodes once and prices 20 candidate slots traffic-aware
  costs ~$0.205. Free monthly caps are per-SKU: 10,000 Geocoding, 10,000 Essentials elements, 5,000
  Pro elements — the old $200 monthly credit was removed on 2025-03-01.
- **Routes API, not Distance Matrix.** Distance Matrix API is in **Legacy** status — *"This API is now
  in legacy mode. Use Compute Route Matrix instead."* — and since 2025-03-01 it cannot be enabled on
  new Cloud projects at all. No sunset date, but Google commits to only 12 months' notice.
- **Traffic-aware routing is not worth paying for on slots weeks out.** Nothing in the docs forbids a
  far-future `departureTime` for `DRIVE`, and no maximum horizon is documented — but Google states
  traffic-aware preferences are *"Recommended for departures happening in the near future"* and that
  *"the farther ahead you set the departure time into the future, the more consideration is given to
  historical traffic conditions"*. Beyond the near term you pay the 2× Pro rate for something
  converging on `staticDuration`. Recommendation: `TRAFFIC_AWARE` inside ~24h, `TRAFFIC_UNAWARE`
  beyond it.

---

## 1. Routes API — Compute Route Matrix

### Endpoint and request shape

`POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`
([reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)).

Google's own worked example, verbatim from
[Get a route matrix](https://developers.google.com/maps/documentation/routes/compute_route_matrix):

```bash
curl -X POST -d '{
  "origins": [
    {
      "waypoint": {
        "location": { "latLng": { "latitude": 37.420761, "longitude": -122.081356 } }
      },
      "routeModifiers": { "avoid_ferries": true}
    },
    {
      "waypoint": {
        "location": { "latLng": { "latitude": 37.403184, "longitude": -122.097371 } }
      },
      "routeModifiers": { "avoid_ferries": true}
    }
  ],
  "destinations": [
    {
      "waypoint": {
        "location": { "latLng": { "latitude": 37.420999, "longitude": -122.086894 } }
      }
    },
    {
      "waypoint": {
        "location": { "latLng": { "latitude": 37.383047, "longitude": -122.044651 } }
      }
    }
  ],
  "travelMode": "DRIVE",
  "routingPreference": "TRAFFIC_AWARE"
}' \
-H 'Content-Type: application/json' \
-H 'X-Goog-Api-Key: YOUR_API_KEY' \
-H 'X-Goog-FieldMask: originIndex,destinationIndex,duration,distanceMeters,status,condition' \
'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix'
```

Request body fields, per the
[reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix):
`origins[]` (required), `destinations[]` (required), `travelMode`, `routingPreference`,
`departureTime`, `arrivalTime`, `languageCode`, `regionCode`, `units`, `extraComputations[]`,
`trafficModel`, `transitPreferences`.

### Authentication

The Routes API usage page states, verbatim: *"To use the Routes API, you must enable billing on each
of your projects and include an **API key or OAuth token** with all API or SDK requests"*
([Routes API Usage and Billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)).

The setup page says only: *"You need to include your API key in every Routes API request, preferably
using HTTPS"*
([Set up the Routes API](https://developers.google.com/maps/documentation/routes/get-api-key)).

For client libraries: *"When you use client libraries, you use Application Default Credentials (ADC)
to authenticate"*, and the official Node package is `@googlemaps/routing`
([Routes API client libraries](https://developers.google.com/maps/documentation/routes/client-libraries)).

Google's platform-wide security guidance says apps *"must use API keys or, if supported, OAuth 2.0, to
authenticate themselves"*, that for server-to-server *"you need a service account"*, and — directly
relevant to us — *"For server-side applications, Google recommends using OAuth 2.0 over API keys"*
([Google Maps Platform security guidance](https://developers.google.com/maps/api-security-best-practices)).
See [Could not verify](#could-not-verify) — no published OAuth scope string for Routes API v2, and no
"Authorization Scopes" section on the v2 REST reference.

### `X-Goog-FieldMask` — required

Verbatim from [Choose fields to return](https://developers.google.com/maps/documentation/routes/choose_fields):

> "When you request a route or route matrix, you must use a field mask to specify what information the
> response should return. There is no default list of returned fields. If you don't specify a field
> mask, the methods return an error."

To get travel duration back, request `duration`. The
[reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)
gives this as *"an example production setup"*:

```
X-Goog-FieldMask: originIndex,destinationIndex,status,condition,distanceMeters,duration
```

Two gotchas worth encoding in our client:

- **Do not use `*` in production.** *"While you can use this wildcard field mask while in development
  to determine what fields you need, don't use it in production. Requesting all fields in production
  results in higher costs and longer response times."*
  ([choose_fields](https://developers.google.com/maps/documentation/routes/choose_fields))
- **Default values are omitted even when masked in.** *"When a response message is parsed, and a field
  in the response message contains its default value, the field may be omitted from the response even
  if you specified it in the response field mask… For example, when you compute a route matrix, the
  `distanceMeters` field of the response can contain a value of 0, its default value. Because 0 is
  the default value of `distanceMeters`, it is omitted from the response."*
  ([choose_fields](https://developers.google.com/maps/documentation/routes/choose_fields)) — so our
  parser must treat a missing `duration`/`distanceMeters` as `0`, not as an error.

### Response shape and index mapping

The response is a **flat JSON array of elements, not a matrix**. From
[Get a route matrix](https://developers.google.com/maps/documentation/routes/compute_route_matrix):

```json
[
    { "originIndex": 0, "destinationIndex": 0, "status": {}, "distanceMeters": 822,  "duration": "160s", "condition": "ROUTE_EXISTS" },
    { "originIndex": 1, "destinationIndex": 0, "status": {}, "distanceMeters": 2919, "duration": "361s", "condition": "ROUTE_EXISTS" },
    { "originIndex": 1, "destinationIndex": 1, "status": {}, "distanceMeters": 5598, "duration": "402s", "condition": "ROUTE_EXISTS" },
    { "originIndex": 0, "destinationIndex": 1, "status": {}, "distanceMeters": 7259, "duration": "712s", "condition": "ROUTE_EXISTS" }
]
```

Note the ordering above: `(1,1)` comes before `(0,1)`. Google is explicit that order is not
guaranteed and that you must map by index:

> "The elements returned by the stream are not guaranteed to be returned in any order. Therefore, each
> response element contains an `origin_index` and a `destination_index`. For the origins and
> destinations specified by the request, the route origin is equivalent to `origins[origin_index]` for
> a given element and the route destination is equivalent to `destinations[destination_index]`. These
> arrays are zero-indexed. **It is important to store the origin and destination list orders.**"
> ([compute_route_matrix](https://developers.google.com/maps/documentation/routes/compute_route_matrix))

Element fields
([reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)):
`status`, `condition`, `distanceMeters`, `duration`, `staticDuration`, `travelAdvisory`,
`fallbackInfo`, `localizedValues`, `originIndex`, `destinationIndex`.

`duration` vs `staticDuration`, verbatim from the same reference:

> `duration` — "The length of time needed to navigate the route. If you set the `routingPreference` to
> `TRAFFIC_UNAWARE`, then this value is the same as `staticDuration`. If you set the
> `routingPreference` to either `TRAFFIC_AWARE` or `TRAFFIC_AWARE_OPTIMAL`, then this value is
> calculated taking traffic conditions into account."
>
> `staticDuration` — "The duration of traveling through the route without taking traffic conditions
> into consideration."

`RouteMatrixElementCondition` values
([gRPC package reference](https://developers.google.com/maps/documentation/routes/reference/rpc/google.maps.routing.v2)):

| Value | Google's description |
|---|---|
| `ROUTE_MATRIX_ELEMENT_CONDITION_UNSPECIFIED` | "Only used when the status of the element is not OK." |
| `ROUTE_EXISTS` | "A route was found, and the corresponding information was filled out for the element." |
| `ROUTE_NOT_FOUND` | "No route could be found. Fields containing route information, such as `distance_meters` or `duration`, will not be filled out in the element." |

Errors are per-element, which matters for our failure handling:

> "One feature of the Compute Route Matrix methods is that errors can be returned either for the
> entire response or for individual response elements. For example, the entire response contains an
> error if the request is malformed (for example, it has zero origins). However, if an error applies
> to a subset of elements in the response (for example, a route cannot be computed for one
> combination of origin and destination), then only the elements affected by the error return an error
> code."
> ([compute_route_matrix](https://developers.google.com/maps/documentation/routes/compute_route_matrix))

### Hard limits and quota

Verbatim from the
[reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix):

> - "The sum of the number of origins + the number of destinations specified as either `placeId` or
>   `address` must be no greater than 50."
> - "The product of number of origins × number of destinations must be no greater than 625 in any case."
> - "The product of number of origins × number of destinations must be no greater than 100 if
>   `routingPreference` is set to `TRAFFIC_AWARE_OPTIMAL`."
> - "The product of the number of origins × number of destinations must be no greater than 100 if
>   `travelMode` is set to `TRANSIT`."

Note there is **no documented cap on origins or destinations when they are given as `latLng`** — the
50 cap applies only to waypoints expressed as `placeId` or `address`. This is a direct argument for
geocoding once and passing coordinates thereafter.

Rate limits, verbatim from
[Routes API Usage and Billing](https://developers.google.com/maps/documentation/routes/usage-and-billing):

> **Compute Routes**
> - "Rate limit of 3,000 QPM queries per minute."
> - "Maximum allowed number of intermediate waypoints per `ComputeRoutes` request is 25."
>
> **Compute Route Matrix**
> - "The rate limit is 3,000 EPM elements per minute, calculated by number of origins times the number
>   of destinations."
> - "Maximum allowed number of origins and destinations that you can specify by using a place ID or
>   address is 50."
> - "Maximum allowed total number of elements per `ComputeRouteMatrix` request with
>   `routingPreference` set to `TRAFFIC_AWARE_OPTIMAL` is 100."
> - "Maximum allowed total number of elements per `ComputeRouteMatrix` request with `travelMode` set
>   to `TRANSIT` is 100."
> - "Maximum allowed total number of elements per `ComputeRouteMatrix` request otherwise is 625."

**The relevant budget for us is 3,000 elements/minute, not 3,000 requests/minute.** A single 25×25
matrix consumes 625 of that minute's 3,000. No QPS (per-second) figure is published for Routes — see
[Could not verify](#could-not-verify).

---

## 2. Traffic awareness

### `routingPreference` values

Verbatim from the
[RoutingPreference reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/RoutingPreference):

| Value | Google's description |
|---|---|
| `ROUTING_PREFERENCE_UNSPECIFIED` | "No routing preference specified. Default to `TRAFFIC_UNAWARE`." |
| `TRAFFIC_UNAWARE` | "Computes routes without taking live traffic conditions into consideration. Suitable when traffic conditions don't matter or are not applicable. Using this value produces the lowest latency." |
| `TRAFFIC_AWARE` | "Calculates routes taking live traffic conditions into consideration. In contrast to `TRAFFIC_AWARE_OPTIMAL`, some optimizations are applied to significantly reduce latency." |
| `TRAFFIC_AWARE_OPTIMAL` | "Calculates the routes taking live traffic conditions into consideration, without applying most performance optimizations. Using this value produces the highest latency." |

[Set the level of traffic data](https://developers.google.com/maps/documentation/routes/config_trade_offs)
adds detail worth quoting:

> `TRAFFIC_UNAWARE` — "If you choose `TRAFFIC_UNAWARE`, the route and duration chosen are based on road
> network and average time-independent traffic conditions, not current road conditions. Consequently,
> routes may include roads that are temporarily closed."
>
> `TRAFFIC_AWARE_OPTIMAL` — "The `TRAFFIC_AWARE_OPTIMAL` routing preference is equivalent to the mode
> used by maps.google.com and by the Google Maps mobile app."

### They are billed differently — yes

Verbatim caution box on
[Set the level of traffic data](https://developers.google.com/maps/documentation/routes/config_trade_offs):

> "**Caution:** Requests using `TRAFFIC_AWARE` and `TRAFFIC_AWARE_OPTIMAL` are billed at a higher rate.
> Learn more about billing."

And verbatim from
[Routes API Usage and Billing](https://developers.google.com/maps/documentation/routes/usage-and-billing):

> "The features you use determine which SKU category is billed:
> - **Essentials**: Billed for requests that use only basic features with a maximum of 10 intermediate
>   waypoints.
> - **Pro**: Billed for requests that use an advanced feature, such as the `TRAFFIC_AWARE` or
>   `TRAFFIC_AWARE_OPTIMAL` route modifiers.
> - **Enterprise**: Billed for requests that use an enterprise feature, such as two-wheel routing."

So `TRAFFIC_UNAWARE` → *Routes: Compute Route Matrix Essentials*; either traffic-aware value →
*Routes: Compute Route Matrix Pro*. That is a **2× price difference per element** (see §5).
`TRAFFIC_AWARE` and `TRAFFIC_AWARE_OPTIMAL` land in the *same* Pro SKU — the difference between them
is latency and the 100-element cap, not price.

### `departureTime` constraints

**Must it be in the future?** For `DRIVE`, effectively yes. Verbatim from the
[computeRouteMatrix reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix):

> "Optional. The departure time. If you don't set this value, then this value defaults to the time that
> you made the request. **NOTE: You can only specify a `departureTime` in the past when
> `RouteTravelMode` is set to `TRANSIT`.**"

And from [Set the level of traffic data](https://developers.google.com/maps/documentation/routes/config_trade_offs):

> "Use this property only for traffic aware requests where the departure time needs to be in the
> future. If you don't set the `departureTime` property, it defaults to the time that you make the
> request."

**Behaviour if omitted:** it defaults to request time. The traffic-model page repeats this as an
explicit warning about non-determinism:

> "**Note:** If you do not specify a `departureTime`, the implied departure is the request time. This
> means that you may get different values depending on when the request is sent."
> ([Specify the traffic model type to use](https://developers.google.com/maps/documentation/routes/traffic-model))

**Maximum how far ahead?** No maximum is documented for `DRIVE`. The only horizon figures Google
publishes are for transit, and only on the `ComputeRoutes` request (not on `ComputeRouteMatrix`):
*"Transit trips are available for up to 7 days in the past or 100 days in the future"*
([gRPC package reference](https://developers.google.com/maps/documentation/routes/reference/rpc/google.maps.routing.v2)).
Do **not** assume 100 days applies to driving — see [Could not verify](#could-not-verify).

### Is traffic-aware usable for slots weeks in advance?

Google's own guidance, verbatim from
[Set the level of traffic data](https://developers.google.com/maps/documentation/routes/config_trade_offs):

> "`TRAFFIC_AWARE` and `TRAFFIC_AWARE_OPTIMAL`: **Recommended for departures happening in the near
> future** because these preferences take live traffic conditions into consideration. Live traffic
> becomes more important and relevant the closer the `departureTime` is to now. **The farther ahead you
> set the departure time into the future, the more consideration is given to historical traffic
> conditions in selecting routes.**"

Reinforced by the traffic model definition:

> `BEST_GUESS` — "Indicates that the returned `duration` should be the best estimate of travel time
> given what is known about both historical traffic conditions and live traffic. **Live traffic becomes
> more important the closer the `departureTime` is to now.**"
> ([TrafficModel reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TrafficModel))

**Read for our decision:** a traffic-aware call for a slot three weeks out is technically accepted and
returns a duration that reflects *historical* traffic for that time-of-day/day-of-week — which is
genuinely useful (rush hour vs. Sunday morning), but it is not "live traffic", and it is billed at the
Pro rate regardless. Since `staticDuration` is *"the ETA for the route considering only historical
traffic information"* and is returned on every preference including `TRAFFIC_UNAWARE`
([config_trade_offs](https://developers.google.com/maps/documentation/routes/config_trade_offs)), a
far-future traffic-aware request is converging on data we could get from the Essentials SKU at half
the price. Note however that `staticDuration` under `TRAFFIC_UNAWARE` is described as *"average
time-independent traffic conditions"* — i.e. it is *not* time-of-day-aware. The honest trade-off is:
`TRAFFIC_UNAWARE` loses time-of-day sensitivity; `TRAFFIC_AWARE` keeps it but costs 2×.

`trafficModel` (BEST_GUESS / PESSIMISTIC / OPTIMISTIC) is worth knowing about but is **not usable for
buffer-padding on a matrix at scale**: *"`TrafficModel` is only available for requests that have set
`RoutingPreference` to `TRAFFIC_AWARE_OPTIMAL` and `RouteTravelMode` to `DRIVE`"*
([computeRouteMatrix reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)),
and `TRAFFIC_AWARE_OPTIMAL` caps the matrix at 100 elements. The traffic-model guide also carries a
pre-GA banner: *"This product or feature is Experimental (pre-GA)."*
([traffic-model](https://developers.google.com/maps/documentation/routes/traffic-model)).

---

## 3. Legacy status of the Distance Matrix API

**It is in Legacy status. Do not build new work on it.**

The banner on the Distance Matrix API overview, verbatim:

> "This product or feature is in Legacy status. For more information about the Legacy stage and how to
> migrate from Legacy to newer services, see Legacy products and features."
>
> "This API is now in legacy mode. Use Compute Route Matrix instead."
> ([Distance Matrix API (Legacy) overview](https://developers.google.com/maps/documentation/distance-matrix/overview))

Google's definition of the stage, verbatim from
[Legacy products and features](https://developers.google.com/maps/legacy):

> "Legacy is an intermediate lifecycle step to ease the transition between Generally Available services
> and Deprecated services."
>
> "Legacy-marked services will be officially **feature frozen**, and new feature requests will only be
> considered for updated non-Legacy services."
>
> "Legacy-marked services will **retain full support**."

Legacy services are *"not available in new Cloud projects but remain fully supported for existing
projects"*, effective **March 1, 2025**. The same page lists the migration path in a table: Distance
Matrix API → **Routes API**; Directions API → **Routes API**; JS Distance Matrix Service →
**RouteMatrix Class** ([Legacy products and features](https://developers.google.com/maps/legacy)).

**Sunset date — there isn't one**, verbatim:

> "While we envision that Legacy services will be turned down in the coming years, there is no date yet
> for when this will happen."
>
> "…we will provide at least a **12-month notice** prior to the decommission of the services."
> ([Legacy products and features](https://developers.google.com/maps/legacy))

The [Deprecations page](https://developers.google.com/maps/deprecations) carries no entry for the
Distance Matrix API, Directions API, Routes API, or Geocoding API — consistent with "legacy, not yet
deprecated".

**Practical consequence for us:** because Legacy services *"can no longer be enabled"* on new Cloud
projects, a fresh Axentrio Cloud project could not turn Distance Matrix on even if we wanted it. The
question is closed: **Routes API**.

---

## 4. Geocoding API

**Read this first: there are two live versions.** Geocoding API **v4 is Generally Available** as of
**March 30, 2026** (*"Announcing the GA release of the Geocoding API v4"*, after *"Geocoding API v4 is
now in Preview"* on April 30, 2025 —
[release notes](https://developers.google.com/maps/documentation/geocoding/release-notes)). The v3
pages now carry the banner *"Version 4 of the Geocoding API is generally available. To migrate to v4,
see the v3 to v4 Migration guide"*
([Geocoding API overview (v3)](https://developers.google.com/maps/documentation/geocoding/guides-v3/overview)).
v3 is **not** marked Legacy or Deprecated anywhere I could find. The specific fields the brief asked
about (`geometry.location_type`, `partial_match`, `components`) are **v3 concepts**, and two of the
three do not survive into v4. Both are documented below.

### v3 — response shape

`https://maps.googleapis.com/maps/api/geocode/json?address=...&key=...` returns
([Geocoding request and response](https://developers.google.com/maps/documentation/geocoding/requests-geocoding)):

```json
{
    "results": [
        {
            "address_components": [ { "long_name": "1600", "short_name": "1600", "types": ["street_number"] }, ... ],
            "formatted_address": "1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA",
            "geometry": {
                "location": { "lat": 37.4222804, "lng": -122.0843428 },
                "location_type": "ROOFTOP",
                "viewport": { "northeast": { ... }, "southwest": { ... } }
            },
            "place_id": "ChIJRxcAvRO7j4AR6hm6tys8yA8",
            "plus_code": { "compound_code": "CWC8+W7 Mountain View, CA", "global_code": "849VCWC8+W7" },
            "types": ["street_address"]
        }
    ],
    "status": "OK"
}
```

### v3 — `geometry.location_type`, complete set

Verbatim from
[Geocoding request and response](https://developers.google.com/maps/documentation/geocoding/requests-geocoding):

| Value | Google's definition |
|---|---|
| `ROOFTOP` | "indicates that the returned result is a precise geocode for which we have location information accurate down to street address precision." |
| `RANGE_INTERPOLATED` | "indicates that the returned result reflects an approximation (usually on a road) interpolated between two precise points (such as intersections). Interpolated results are generally returned when rooftop geocodes are unavailable for a street address." |
| `GEOMETRIC_CENTER` | "indicates that the returned result is the geometric center of a result such as a polyline (for example, a street) or polygon (region)." |
| `APPROXIMATE` | "indicates that the returned result is approximate." |

For our use — deciding whether a customer address is precise enough to drive to — `ROOFTOP` and
`RANGE_INTERPOLATED` are actionable; `GEOMETRIC_CENTER` means we have a street, not a house;
`APPROXIMATE` typically means a city or region and should be rejected as a booking destination.

### v3 — `partial_match`

Verbatim, same page:

> "`partial_match` indicates that the geocoder did not return an exact match for the original request,
> though it was able to match part of the requested address. You may wish to examine the original
> request for misspellings and/or an incomplete address.
>
> Partial matches most often occur for street addresses that do not exist within the locality you pass
> in the request. Partial matches may also be returned when a request matches two or more locations in
> the same locality. For example, 'Hillpar St, Bristol, UK' will return a partial match for both Henry
> Street and Henrietta Street. Note that if a request includes a misspelled address component, the
> geocoding service may suggest an alternative address. Suggestions triggered in this way will also be
> marked as a partial match."

It appears only when set — a clean match omits the key entirely. Also note it can be triggered by the
`components` filter itself: *"If the geocoder finds a partial match for a component filter, the
response will contain a `partial_match` field"* (same page). Treat `partial_match: true` as
"confirm with the customer before booking travel time against it".

### v3 — restricting by country via `components`

Verbatim, same page:

> "In a Geocoding response, the Geocoding API can return address results restricted to a specific area.
> You can specify the restriction using the `components` filter. A filter consists of a list of
> `component:value` pairs separated by a pipe (`|`)."
>
> "The components that can be filtered include:
> - `postal_code` matches `postal_code` and `postal_code_prefix`.
> - `country` matches a country name or a two letter ISO 3166-1 country code. The API follows the ISO
>   standard for defining countries, and the filtering works best when using the corresponding ISO code
>   of the country."
>
> "The following components may be used to influence results, but **will not be enforced**:
> - `route` matches the long or short name of a route.
> - `locality` matches against `locality` and `sublocality` types.
> - `administrative_area` matches all the `administrative_area` levels."

So `country` and `postal_code` are **hard filters**; `route`, `locality`, `administrative_area` are
**soft biases only**. Example given: *"A geocode for 'High St, Hastings' with `components=country:GB`
returns a result in Hastings, England rather than in Hastings-On-Hudson, USA."* Request form:

```
https://maps.googleapis.com/maps/api/geocode/json?address=high+st+hasting&components=country:GB&key=YOUR_API_KEY
```

Traps, verbatim from the same page:

> - "Do not repeat these component filters in requests, or the API will return `Invalid_request`:
>   `country`, `postal_code`, `route`"
> - "If the request contains repeated component filters, the API evaluates those filters as an AND, not
>   an OR."
> - "For each address component, either specify it in the `address` parameter or in a `components`
>   filter, but not both. Specifying the same values in both may result in `ZERO_RESULTS`."

That last one matters for us: if we send the customer's full typed address in `address` *and* also
pin `components=country:NL`, and the typed string already contains "Netherlands", we can get
`ZERO_RESULTS` from a perfectly valid address.

### v3 — `ZERO_RESULTS` vs. an ambiguous multi-candidate response

`ZERO_RESULTS` is a `status` value: *"`ZERO_RESULTS` indicates that the geocode was successful but
returned no results. This may occur if the geocoder was passed a non-existent address."* The body,
verbatim from the mutually-exclusive-filters example (`components=administrative_area:TX|country:FR`):

```json
{
   "results" : [],
   "status" : "ZERO_RESULTS"
}
```

An **ambiguous** query is a completely different animal: `status` is `"OK"`, and disambiguation is
your problem. Google's wording:

> "Component filtering returns a `ZERO_RESULTS` response only if you provide filters that exclude each
> other."

and, on ambiguity generally:

> "The Places API's Autocomplete method is generally better suited for ambiguous queries, and can
> restrict results to a specific area."
> ([requests-geocoding](https://developers.google.com/maps/documentation/geocoding/requests-geocoding))

v4 states the arity rule explicitly: *"Generally, only one entry in the results array is returned for
address lookups, though the geocoder might return several results when address queries are ambiguous"*
([Geocode an address (v4)](https://developers.google.com/maps/documentation/geocoding/geocoding)).
So the practical discriminator in code is: `status !== "OK"` → hard failure; `status === "OK" &&
results.length > 1` → ambiguous, ask the customer; `results.length === 1 && partial_match` →
low-confidence, confirm.

Full v3 status set, verbatim: `OK`, `ZERO_RESULTS`, `OVER_DAILY_LIMIT` ("The API key is missing or
invalid. / Billing has not been enabled on your account. / A self-imposed usage cap has been exceeded.
/ The provided method of payment is no longer valid"), `OVER_QUERY_LIMIT` ("you are over your quota"),
`REQUEST_DENIED`, `INVALID_REQUEST` ("generally indicates that the query (`address`, `components` or
`latlng`) is missing"), `UNKNOWN_ERROR` ("the request could not be processed due to a server error.
The request may succeed if you try again").

### v4 — what changes, and why it matters to this design

Endpoint host is different: `https://geocode.googleapis.com`, with
`GET /v4/geocode/address/{ADDRESS_STRING}` or `GET /v4/geocode/address?{STRUCTURED_ADDRESS}`
([REST reference](https://developers.google.com/maps/documentation/geocoding/reference/rest),
[Geocode an address](https://developers.google.com/maps/documentation/geocoding/geocoding)). v4
supports `X-Goog-FieldMask` and uses lower camel case.

Verbatim from the
[v3 → v4 migration guide](https://developers.google.com/maps/documentation/geocoding/geocoding-v4-migrate):

| v3 field | v4 field | Google's note |
|---|---|---|
| `status`, `error_message` | Removed | "v4 uses HTTP status codes and error bodies." |
| `results.geometry.location_type` | `results.granularity` | "Renamed." |
| `results.geometry.location` | `results.location` | "Field names: lat/lng -> latitude/longitude." |
| `results.geometry.viewport` | `results.viewport` | "Field names: northeast/southwest -> high/low." |
| **`results.partial_match`** | **Removed** | (no note) |

`granularity` keeps the same four values with slightly reworded definitions
([GeocodeResult.Granularity](https://developers.google.com/maps/documentation/geocoding/reference/rest/v4/GeocodeResult.Granularity)):
`ROOFTOP` — "The non-interpolated location of an actual plot of land corresponding to the matched
address."; `RANGE_INTERPOLATED` — "Interpolated from a range of street numbers…"; `GEOMETRIC_CENTER` —
"The geometric center of a feature for which we have polygonal data."; `APPROXIMATE` — "Everything
else."

**Two v4 regressions that bear directly on our build:**

1. **No hard country filtering.** Verbatim: *"Forward Geocoding in Geocoding v3 included a `components`
   parameter that enabled hard filtering of results for specific components (e.g.,
   `components=country:US`). **Forward Geocoding in v4 does not support this type of hard filtering in
   the request parameters.**… To achieve behavior similar to v3's hard component filters, you must
   implement client-side filtering on the `results` array returned by the v4 API based on the
   `postalAddress` and `addressComponents` objects in the response."* The mapping Google gives is
   `country` → `postalAddress.regionCode`, `postal_code` → `postalAddress.postalCode`,
   `administrative_area` → `postalAddress.administrativeArea` or `addressComponents`. Google also
   warns: *"It is not recommended to filter on other fields as reliable filtering criteria does not
   exist."*
2. **No `partial_match`.** We lose the single cheapest low-confidence signal. `granularity` is the
   remaining proxy.

Also verbatim from the migration guide, relevant to how we call it: *"**Warning:** Due to the security
risks, you shouldn't call Geocoding API v4 methods directly from client-side JavaScript."* — server-side
only, which is what we want anyway.

**Recommendation:** build against **v3** for the first slice. It gives us hard `country` restriction
and `partial_match` for free, it is not deprecated, and it is the version whose `components` semantics
our validation logic wants. Revisit when v3 gets a Legacy banner.

### Geocoding quota

> "Geocoding API v4 methods have a default quota of **25 queries per second (QPS)**."
> ([Geocoding API Usage and Billing](https://developers.google.com/maps/documentation/geocoding/usage-and-billing))

The same page notes *"Queries per minute are calculated as the sum of client-side and server-side
queries"* and that *"Daily quotas are refreshed daily at midnight Pacific time"*. See
[Could not verify](#could-not-verify) regarding the v3 rate limit specifically.

---

## 5. Pricing

**Retrieved 2026-08-06. The pricing page itself states "Last updated 2026-07-31 UTC."** These change;
re-check before committing to a number in a customer-facing quote.

Source: [Google Maps Platform core services pricing list](https://developers.google.com/maps/billing-and-pricing/pricing).
Verbatim usage key from that page: *"Costs - per 1000 events · Prices - USD · Ranges - number of
monthly events · Free usage - billable events at no cost"*. Also verbatim: *"Service usage is
calculated on a monthly basis. To determine the applicable volume pricing tier, Google aggregates
service usage for all projects linked to the customer billing account for the applicable month."*

### Compute Route Matrix — billed per element

Verbatim from
[Routes API Usage and Billing](https://developers.google.com/maps/documentation/routes/usage-and-billing):

> "Compute Routes requests are billed for each **Request**."
>
> "Compute Route Matrix requests are billed per **ELEMENT** returned from the request. The number of
> elements is the number of origins multiplied by the number of destinations. For example, if a
> request contains two origins and three destinations, then the request is billed for six elements."

| SKU | SKU ID | Free monthly cap | Cap–100k | 100k–500k | 500k–1M | 1M–5M | 5M+ |
|---|---|---|---|---|---|---|---|
| Routes: Compute Route Matrix **Essentials** (`TRAFFIC_UNAWARE`) | `9392-1087-2045` | 10,000 | $5.00 | $4.00 | $3.00 | $1.50 | $0.38 |
| Routes: Compute Route Matrix **Pro** (`TRAFFIC_AWARE` / `TRAFFIC_AWARE_OPTIMAL`) | `2E25-887A-DAD4` | 5,000 | $10.00 | $8.00 | $6.00 | $3.00 | $0.75 |
| Routes: Compute Route Matrix **Enterprise** | `CEB3-E352-A99B` | 1,000 | $15.00 | $12.00 | $9.00 | $4.50 | $1.14 |

(All figures per 1,000 elements, USD —
[pricing list](https://developers.google.com/maps/billing-and-pricing/pricing).)

**Yes, the routingPreference tiers are billed differently** — traffic-aware is exactly 2× traffic-unaware
at every volume band. `TRAFFIC_AWARE` and `TRAFFIC_AWARE_OPTIMAL` are billed identically to each other.

### Geocoding

| SKU | SKU ID | Free monthly cap | Cap–100k | 100k–500k | 500k–1M | 1M–5M | 5M+ |
|---|---|---|---|---|---|---|---|
| Geocoding (Essentials) | `BAC8-4E68-E261` | 10,000 | $5.00 | $4.00 | $3.00 | $1.50 | $0.38 |

(Per 1,000 requests, USD — listed in the Places table on the
[pricing list](https://developers.google.com/maps/billing-and-pricing/pricing).)

### Free tier — it changed on 2025-03-01

Verbatim from
[Changes to Google Maps Platform automatic volume discounts, monthly credit, and services transitioning to Legacy status](https://developers.google.com/maps/billing-and-pricing/faq):

> "To help you identify, evaluate, and test our Services, we are modifying the USD $200 monthly
> recurring credit by offering a free monthly usage threshold for each Core Services SKU."

| Tier | Free monthly billable events |
|---|---|
| Essentials | 10,000 |
| Pro | 5,000 |
| Enterprise | 1,000 |

> "All changes described in the notice went into effect on **March 1, 2025**."

The caps are **per SKU, not pooled**. So we get 10,000 free Geocoding requests *and* 10,000 free
Essentials elements *and* 5,000 free Pro elements every month.

### What a booking lookup actually costs

Assumptions stated so they can be challenged: one geocode per new customer address (cached
thereafter — subject to §6), and one route-matrix call per availability query with 1 origin ×
N candidate slots.

| Scenario | Elements | Rate | Cost |
|---|---|---|---|
| Geocode a new customer address | 1 request | $5.00/1k | **$0.005** |
| Price 20 slots, `TRAFFIC_UNAWARE` | 20 | $5.00/1k | **$0.10** |
| Price 20 slots, `TRAFFIC_AWARE` | 20 | $10.00/1k | **$0.20** |
| Full first-time lookup, traffic-aware | 1 + 20 | — | **~$0.205** |
| Full first-time lookup, traffic-unaware | 1 + 20 | — | **~$0.105** |

At 10,000 bookings/month with 20 traffic-aware candidate slots each, that is 200,000 Pro elements:
5,000 free, then 95,000 @ $10.00/1k = $950, then 100,000 @ $8.00/1k = $800 → **~$1,750/month** in
Route Matrix alone. Halving to `TRAFFIC_UNAWARE` roughly halves it. **The per-element billing model
means the cost driver is candidate-slot fan-out, not booking volume** — a design that prices 60 slots
instead of 20 triples the bill. Narrowing the candidate window before calling is the single highest-
leverage cost control available to us.

---

## 6. Terms of Service — caching and persistent storage

**This is the section that decides whether the planned design is legal. Read it before writing code.**

Two documents govern, and the split between them changed recently — this matters, because the
30-day rule people quote from memory is **no longer in the main ToS at all**:

- **[Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms)** —
  page states **"Last modified June 23, 2026"**.
- **[Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)** —
  page states **"Last modified June 10, 2026"**.

### The governing rule is default-deny

Verbatim, §3.2.3(b) of the
[Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms):

> **"(b) No Caching.** Customer will not cache Google Maps Content except as expressly permitted under
> the Maps Service Specific Terms."

That is the whole clause. **The main ToS no longer contains any 30-day allowance** — it delegates
entirely. The practical consequence is that anything the Service Specific Terms do not *expressly*
permit is prohibited. Silence is not permission.

Verbatim, §3.2.3(a), which explicitly names our data type in its examples:

> **"(a) No Scraping.** Customer will not export, extract, or otherwise scrape Google Maps Content for
> use outside the Services. For example, Customer will not: (i) pre-fetch, index, store, reshare, or
> rehost Google Maps Content outside the services; (ii) bulk download Google Maps tiles, Street View
> images, geocodes, directions, **distance matrix results**, roads information, places information,
> elevation values, and time zone details; (iii) copy and save business names, addresses, or user
> reviews; or (iv) use Google Maps Content with text-to-speech services."

And the definition that determines scope, verbatim from the same document:

> "**'Google Maps Content'** means any content provided through the Services (whether created by Google
> or its third-party licensors), including map and terrain data, imagery, traffic data, and places data
> (including business listings)."

### May lat/lng be stored indefinitely? No — 30 days, with one narrow exception

Verbatim, §6.3 (Geocoding API) of the
[Maps Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms):

> **"6.3 Caching.**
>
> **6.3.1** Customer may temporarily cache latitude (lat) and longitude (lng) values from the Geocoding
> API for up to 30 consecutive calendar days, after which Customer must delete the cached latitude and
> longitude values.
>
> **6.3.2** Customer may indefinitely cache latitude (lat), longitude (lng), formatted_address, and the
> structured address values from the Geocoding API solely to support the direct, End User facing
> functionality of the Customer Application that initiated the request (e.g., displaying the address of
> a location in a weather application, associating location data with a photograph), only where the
> cache is not used as a replacement for making an additional call to the Services. Cached data must be
> logically isolated to the specific End User it is associated with and must not be used across
> multiple End Users."

And verbatim, §19.3 (Routes API), same document:

> **"19.3 Caching.** Customer may temporarily cache latitude (lat) and longitude (lng) values from the
> Routes API for up to 30 consecutive calendar days, after which Customer must delete the cached
> latitude and longitude values."

**Assessment of our design against §6.3.2.** The indefinite exception carries three conjunctive
conditions, and our plan fails at least one and arguably two:

1. *"solely to support the direct, End User facing functionality of the Customer Application that
   initiated the request"* — arguable. Showing the customer their own confirmed appointment address
   plausibly qualifies; using it to compute a tenant's route plan does not.
2. *"only where the cache is not used as a replacement for making an additional call to the Services"* —
   **we fail this.** The entire point of persisting lat/lng on the booking row is to avoid re-geocoding
   on every availability computation. That is precisely "a replacement for making an additional call".
3. *"Cached data must be logically isolated to the specific End User it is associated with and must not
   be used across multiple End Users"* — **we fail this too.** A booking row's coordinates are read by
   the tenant (the business owner) and by the scheduling engine, not only by the end user who supplied
   the address.

**Conclusion: 30 days is our ceiling for lat/lng, from both APIs.** Not "the lifetime of a booking".

### May computed travel times/durations be cached, and for how long?

**Not expressly permitted — for any period.** §19.3 (Routes API) permits caching *"latitude (lat) and
longitude (lng) values"* and nothing else. It does not mention `duration`, `staticDuration`, or
`distanceMeters`. Combined with §3.2.3(b)'s default-deny, the plain reading is that caching travel
durations from the Routes API is **not permitted**.

This is not an oversight in my reading — Google clearly knows how to write the permission when it
means to grant it. Verbatim, §11.8 (Navigation Connect API), same document:

> **"11.8 Caching.** Customer may temporarily cache latitude (lat), longitude (lng), **distance,
> duration, time, and estimated time of arrival values** for up to 30 consecutive calendar days, after
> which Customer must delete the cached values."

Two adjacent sections in one document; one enumerates duration and ETA, the other does not. §3.2.3(a)
also names *"distance matrix results"* explicitly in the No Scraping prohibition. Note also the
**Distance Matrix API section (§5) has no caching clause at all** — only §5.1 and §5.2 about map
display — reinforcing that no duration-caching permission exists on that path either.

**This is the highest-risk item in the whole design and needs legal sign-off before we build the Redis
duration cache.** Google does not say "you may not cache durations" in those words; it declines to
permit it, under a clause that prohibits whatever is not permitted. That is a legal judgement call
above my pay grade, but the textual position is not ambiguous.

If we need a defensible position, the two viable shapes are: (a) request durations live on every
availability computation and never persist them; or (b) if a short cache is judged acceptable, keep it
strictly under 30 days, delete on expiry, and never let it outlive the booking — but understand that
(b) rests on an argument Google has not made for us.

### Is `place_id` treated differently from coordinates? **Yes — plainly and materially.**

**Place IDs may be stored indefinitely. Coordinates may not.** Both rules, quoted:

Verbatim, General Service Terms §3 of the
[Maps Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms):

> **"3. Google ID Caching.** Customer may cache the Google ID values from the Services that return such
> field and allow caching, in accordance with its Documentation. For example, Customer may cache (a)
> place_id from Places API, Directions API, Geolocation API and **Routes API**, (b) pano_ID, from Street
> View Static API, and (c) video_ID from Aerial View API."

Verbatim, [Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id):

> "Place IDs are **exempt from** the caching restrictions stated in Section 3.2.3(b) of the Google Maps
> Platform Terms of Service."

Verbatim, [Policies and attributions for Geocoding API](https://developers.google.com/maps/documentation/geocoding/policies):

> "…the place ID, used to uniquely identify a place, is exempt from caching restrictions" and you "can
> therefore store place ID values indefinitely."

Against, verbatim, §6.3.1 and §19.3 as quoted above: lat/lng — *"for up to 30 consecutive calendar
days, after which Customer must delete the cached latitude and longitude values."*

**The one maintenance obligation on place IDs**, verbatim from
[Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id):

> "Because Place IDs may change due to updates on the Google Maps database, Google recommends
> refreshing place IDs if they are more than 12 months old. You can refresh Place IDs **at no charge**
> by making a Place Details request, specifying only the place ID field in the `fields` parameter."

**This is the architecture the terms are pushing us toward:** store `place_id` (and, if needed under
§6.3.2's narrow terms, `formatted_address`) as the durable identity on the booking row; treat lat/lng
as a ≤30-day derived cache with a hard TTL and a deletion job; re-resolve from `place_id` when the
cache expires; refresh place IDs older than 12 months for free. Note the cost consequence: the Route
Matrix 50-waypoint cap applies to origins/destinations *"specified as either `placeId` or `address`"*,
so a design that passes place IDs straight through hits a tighter matrix limit than one that resolves
to `latLng` first ([computeRouteMatrix reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)).

### Attribution, and using the data with a non-Google map or no map

**Both APIs may be used with no map at all.** Verbatim from the
[Maps Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms):

> **"6.1 Use without a Google Map.** Customer may use Google Maps Content from the Geocoding API in
> Customer Applications without a corresponding Google Map."
>
> **"19.1 Use without a Google Map.** Customer may use Google Maps Content from the Routes API in
> Customer Applications without a corresponding Google Map."

**Neither may be used with a non-Google map.** Verbatim:

> **"6.2 No use with a non-Google map.** Customer must not use Google Maps Content from the Geocoding
> API in conjunction with a non-Google map."
>
> **"19.2 No use with a non-Google map.** Customer must not use Google Maps Content from the Routes API
> in conjunction with a non-Google map."

Backed by the main ToS §3.2.3(e), verbatim
([Terms of Service](https://cloud.google.com/maps-platform/terms)):

> **"(e) No Use With Non-Google Maps.** To avoid quality issues and/or brand confusion, Customer will not
> use the Google Maps Core Services with or near a non-Google Map in a Customer Application. For
> example, Customer will not (i) display or use Places content on a non-Google Map, (ii) display Street
> View imagery and non-Google Maps on the same screen, or (iii) link a Google Map to non-Google Maps
> Content or a non-Google Map."

**Practical rule for the portal: no Leaflet/OSM/Mapbox anywhere on a screen that shows a Google-derived
travel time or geocode.** If we ever want a map on the booking screens it must be a Google map.

**Attribution.** Main ToS §3.2.2(b), verbatim: *"Customer will display all attribution that (i) Google
provides through the Services (including branding, logos, and copyright and trademark notices); or (ii)
is specified in the Maps Service Specific Terms. Customer will not modify, obscure, or delete such
attribution."* The per-API policy pages give the concrete requirement:

> "Routes API results displayed on a map must be shown on a Google Map, and attribution, including the
> Google logo, is required if not displayed on a Google Map."
> ([Policies and attributions for Routes API](https://developers.google.com/maps/documentation/routes/policies))
>
> "You don't need to add extra attribution if the Content is shown on a Google Map where the attribution
> is already visible."
> ([Routes API policies](https://developers.google.com/maps/documentation/routes/policies))
>
> "Attribution should take the form of the Google Maps logo whenever possible. In cases where space is
> limited, the text **Google Maps** is acceptable."
> ([Geocoding API policies](https://developers.google.com/maps/documentation/geocoding/policies))

Logo/text specs from the same policy pages: logo minimum height 16dp, maximum 19dp, clear space 10dp
left/right/top and 5dp bottom, *"Don't modify the logo in any way"*; text attribution in Roboto (sans-serif
fallback), weight 400, 12–16sp, white / black `#1F1F1F` / gray `#5E5E5E`, minimum 4.5:1 contrast,
*"positioned near the top or bottom of the content, and within the same visual container"*.

**Since we are displaying travel times in the portal and not on a Google Map, Google attribution is
required on those surfaces.** This is a UI work item, not a footnote.

### If our billing address is in the EEA, a different document governs

Verbatim from the [Terms of Service](https://cloud.google.com/maps-platform/terms):

> "If Customer's billing account address is in the European Economic Area, the Google Maps Platform EEA
> Terms of Service (as described at https://cloud.google.com/terms/maps-platform/eea) ('EEA TOS'), will
> govern Customer's access to and use of the Services. However, to the extent that a Customer's project
> integration existing prior to July 8, 2025 remains in an unmodified state, such project integration
> will continue to be governed by the terms of this Agreement, and not the EEA TOS."

I checked the
[EEA Service Specific Terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms)
(also "Last modified June 10, 2026"). **The caching rules are identical** — EEA §6.2.1/§6.2.2 for
Geocoding and §20.2 for Routes carry the same 30-day text word for word, and the `place_id` General
Terms §3 is identical. **The map rules are different and more permissive**, verbatim:

> **"6.1 No Use With any Map.** Other than latitude, longitude, and place_id, Customer may not use Google
> Maps Content from the Geocoding API With any Map."
>
> **"20.1 No Use With any Map.** Customer may not use description or steps from the Routes API With any
> Map."

So under the EEA terms, lat/lng and place_id *may* be shown with a non-Google map. **Determine which
document binds Axentrio's billing account before relying on either map rule.** The caching answer is
the same either way, which is the part that decides the build.

---

## Could not verify

Each of these was searched for in first-party documentation and not found. None is filled in from
memory or inference.

1. **A maximum future horizon for `departureTime` when `travelMode` is `DRIVE`.** The only horizon
   figures Google publishes — *"Transit trips are available for up to 7 days in the past or 100 days in
   the future"* — appear on the **`ComputeRoutes`** request field and are scoped to **transit**. That
   sentence is absent from the `ComputeRouteMatrix` `departure_time` description entirely
   ([gRPC package reference](https://developers.google.com/maps/documentation/routes/reference/rpc/google.maps.routing.v2)).
   No driving-mode maximum is documented anywhere I could find. **Do not assume 100 days applies to
   driving.** If a far-future horizon is load-bearing for the design, test it empirically against the
   live API before committing.
2. **The error returned for a past `departureTime` on a non-`TRANSIT` request.** The docs state the
   constraint (*"You can only specify a `departureTime` in the past when `RouteTravelMode` is set to
   `TRANSIT`"*) but never name the resulting status or error code.
3. **The complete feature→SKU trigger table for Routes.** The billing page says *"See the SKU details
   for a complete list of features that trigger these SKUs"*, but the SKU-details table on that page
   only lists SKU names and links back to the pricing list. `TRAFFIC_AWARE`/`TRAFFIC_AWARE_OPTIMAL` →
   Pro is stated explicitly and is safe; the exhaustive list of *other* Pro/Enterprise triggers is not
   published in a form I could retrieve, so treat "Essentials unless proven otherwise" as unverified
   for any feature beyond routing preference.
4. **An OAuth scope string, or an "Authorization Scopes" section, for Routes API v2.** The billing page
   says *"include an API key or OAuth token"*
   ([usage-and-billing](https://developers.google.com/maps/documentation/routes/usage-and-billing)) and
   the platform security page says server-side apps should prefer OAuth
   ([security guidance](https://developers.google.com/maps/api-security-best-practices)), but the v2
   REST reference has no Authorization Scopes section and there is no Routes-specific "Use OAuth" page
   in the v2 documentation set. **Whether a service-account bearer token is accepted by
   `routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`, and under what scope, is unverified.**
   Plan for an API key with IP restrictions as the known-good path; spike OAuth before depending on it.
5. **A QPS (per-second) rate limit for the Routes API.** Only QPM/EPM figures are published. Whether a
   burst of 3,000 elements inside one second is accepted or throttled is not documented.
6. **The rate limit for Geocoding API *v3* specifically.** The usage page states 25 QPS for *"Geocoding
   API v4 methods"* ([usage-and-billing](https://developers.google.com/maps/documentation/geocoding/usage-and-billing));
   I could not find an equivalently explicit current figure scoped to v3.
7. **Any clause permitting the caching of computed durations from the Routes API.** Searched every
   caching clause in both the standard and EEA Service Specific Terms. §19.3 (Routes) covers lat/lng
   only; §11.8 (Navigation Connect) is the only clause in either document that names duration/ETA; the
   Distance Matrix section (§5) has no caching clause at all. **The absence is the finding**, and under
   §3.2.3(b)'s default-deny it reads as a prohibition — but Google never states it affirmatively, so
   this is the item to put in front of counsel rather than resolve internally.
8. **Whether an in-memory/Redis cache is treated differently from database storage.** No clause in
   either terms document distinguishes storage medium. The rules are written in terms of "cache" and
   "delete", with no carve-out for ephemeral or in-process caches. I found nothing suggesting Redis is
   treated more leniently than Postgres, and would not assume it is.
9. **A Legacy or Deprecated designation for Geocoding API v3.** v3 pages carry only a "migrate to v4"
   banner ([v3 overview](https://developers.google.com/maps/documentation/geocoding/guides-v3/overview));
   v3 does not appear in the
   [Legacy products](https://developers.google.com/maps/legacy) table or on the
   [Deprecations page](https://developers.google.com/maps/deprecations). Its long-term status is
   therefore unstated, not "safe" — the direction of travel is obvious even if the commitment isn't.
10. **A turndown date for the Distance Matrix API.** Explicitly none exists yet; the only commitment is
    *"at least a 12-month notice"* ([Legacy products](https://developers.google.com/maps/legacy)).
