# KPI menu

Use this when the user has not named measurable success criteria, to propose three to five
KPIs that fit their project. Rewrite them in the project's own words and suggest a target for
each, so the user only has to pick and adjust.

## What makes a KPI usable here

- **It is a number with a target and a direction:** "at least 80% of simulated leads are
  qualified", not "good qualification".
- **Something can measure it.** Prefer KPIs a command can measure during the build. A KPI that
  exists only with real users needs a proxy for the build and instrumentation for after launch.
- **It reflects what the user is paying for.** One or two outcome KPIs (the thing the product
  is for), plus guardrails (cost, speed, reliability) that stop the outcome being bought at any
  price.
- **Few.** Three to five. Each one costs a measurement step and an optimization step.

When the user gives a loose goal ("more booked calls", "save my team time"), turn it into a
measurable KPI and confirm the wording and the target in the question round.

## Automations, bots and agents

| KPI | Measured in the build by | Typical target |
| --- | --- | --- |
| Task success rate: runs that reach the correct end state | A scenario suite of realistic inputs with expected outcomes | 90 to 98% |
| Answer or output quality | A rubric scored by a judge model over simulated cases, with a saved baseline | At or above the pass mark on every scenario |
| Rule compliance: never invents prices, follows tone and policy settings | The same suite, counting violations | 0 violations |
| Human-intervention rate: runs that need a person | Scenario suite, counting handoffs that were not required | Under 10 to 20% |
| Time to first response, or time per run | A timing harness around the pipeline with mocked vendors | Seconds, stated per channel |
| Cost per run or per conversation | Token and API usage recorded by the suite, priced | A ceiling in currency |
| Reliability: duplicates, lost or out-of-order messages | Fault-injection and duplicate-delivery tests | 0 |
| Qualified-lead or booking rate (live only) | Proxy: simulated customers. Live: events and a dashboard | The user's current rate plus a margin |

## Websites and landing pages

| KPI | Measured in the build by | Typical target |
| --- | --- | --- |
| Performance | Lighthouse on mobile for the key pages | 90 or more |
| Core Web Vitals | Lighthouse or lab run: LCP, CLS, INP | LCP under 2.5 s, CLS under 0.1, INP under 200 ms |
| Accessibility | Lighthouse and axe | 95 or more, 0 critical issues |
| SEO basics | Lighthouse SEO, plus checks for titles, meta, sitemap, structured data | 95 or more |
| Page weight | Bundle and transfer-size budget in CI | A stated budget per page |
| Conversion rate (live only) | Proxy: the conversion path completes in an end-to-end test on mobile and desktop, and analytics events fire. Live: analytics | The user's target |
| Form completion and error rate (live only) | Proxy: end-to-end tests of every form state. Live: events | The user's target |

## Web and mobile apps

| KPI | Measured in the build by | Typical target |
| --- | --- | --- |
| Core journeys work | End-to-end tests of the three to five journeys that matter | 100% passing |
| Speed of key actions | Timed end-to-end runs or API latency tests | p95 under a stated limit |
| Throughput under load | A load test at the expected peak | Holds the latency limit at N users |
| Data isolation and permissions | Tests that try every cross-user and cross-tenant access | 0 leaks |
| Test coverage of core logic | Coverage on the domain packages only | 80 to 90% |
| Error rate (live only) | Proxy: fault-injection tests. Live: error tracking | Under 1% of requests |
| Activation or retention (live only) | Proxy: onboarding completes in an end-to-end test in under N steps. Live: product analytics | The user's target |
| Running cost per user or per month | A cost model from the architecture and measured usage | A ceiling in currency |

## Data pipelines, scrapers and integrations

| KPI | Measured in the build by | Typical target |
| --- | --- | --- |
| Completeness: records captured out of records available | Runs against recorded fixtures with known counts | 98% or more |
| Accuracy of extracted fields | Comparison with a hand-checked sample | 97 to 99% per field |
| Freshness: delay from source to destination | Timing harness | A stated limit |
| Failure recovery | Tests that kill and resume runs; duplicate detection | No loss, no duplicates |
| Cost per thousand records | Measured usage, priced | A ceiling in currency |

## Asking

Offer the outcome KPI first and mark your recommended set. Put the targets in the option text
so one selection settles both. Add a guardrail on cost whenever the product calls a paid API on
every run, because that is where running costs surprise people.
