# Extra-host discovery for Add Website

Question: how do we find hosts like `app.valyro.be` without owning the domain, without a fixed prefix list?

## What we have now

DNS prefixes (`app`, `api`, `chat`, `ops`, …) plus an optional crt.sh JSON query. Prefixes miss custom names. crt.sh often returns HTTP 502 from the API process.

Checked 2026-08-22:

- Valyro prefix brute-force: only `www` and `app`.
- Axentrio prefix brute-force: `www`, `app`, `api`, `mail`, plus `chat` and `ops` after we added those prefixes.

## Public sources (primary)

Certificate Transparency logs record every publicly trusted TLS cert. That is the design of CT, not a side effect of a scraper. See [What is CT](https://www.certificate-transparency.org/what-is-ct) and [RFC 6962](https://www.rfc-editor.org/rfc/rfc6962).

Raw logs have no search. You query an **index**:

1. **crt.sh** (Sectigo) — `GET https://crt.sh/?q=%.apex&output=json`. Free. No key. Unreliable under load (502 in this session).
2. **crt.name** — `GET https://crt.name/v1/search?apex=valyro.be`. Free, no token, 1000 requests per IP per day. Indexes Chrome/Apple CT logs plus older names from Internet Archive, Common Crawl, ICANN CZDS, Chaos. Returns one subdomain per line. Verified 2026-08-22 against Valyro.
3. **Shodan CTL** — `GET https://ctl.shodan.io/api/v1/domain/{domain}/hostnames`. First-party Shodan docs: [Certificate Transparency Log](https://book.shodan.io/developer-apis/certificate-transparency/).
4. **Rapid7 Project Sonar FDNS** — huge forward-DNS dumps, not suitable as a live API call from our request path. See [opendata.rapid7.com/sonar.fdns_v2](https://opendata.rapid7.com/sonar.fdns_v2/).

Prefix brute-force stays useful as a fast path when CT is down.

## Valyro check with crt.name

`GET /v1/search?apex=valyro.be` returned names the prefix list never guessed:

- `app.valyro.be`
- `start.valyro.be`
- `stap1.valyro.be`
- `kompas.valyro.be`
- `mvdak.valyro.be`
- `mvsolar.valyro.be`
- `avrs-team.valyro.be`
- `email.mail.valyro.be`

Those look like HighLevel funnels and client brands, not `app`/`api`/`www`.

## Recommendation

Keep DNS prefixes. Replace crt.sh as the primary extra-name source with **crt.name search** (fallback crt.sh, then prefixes only).

Then, as today:

- Keep only names under the same apex.
- Resolve DNS.
- Drop non-public IPs.
- Hide `www` / apex as the same site.
- Show the rest as unticked “Also found”. Never auto-import.

Do not call Rapid7 dumps from the API. Do not import `app.` / `api.` / `mail.` by default (portal, API, mail).

## Out of scope

Active port scans, zone transfers, and guessing customer CRM data behind login.
