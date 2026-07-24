# SafeFlash HackSprint day-of feature plan

## Honest baseline

Before the official hacking window, SafeFlash already includes:

- a server-owned `ExecutableIncidentProfile` registry;
- real C/CMake/CTest fixtures for a simulated Battery charger and Motor drive;
- three isolated candidate patches per profile;
- the same non-compensable selector for both device classes;
- profile/version/command-policy/source/test-count evidence binding;
- `npm run demo:cross-device`;
- a compact cross-device proof in Technical Evidence.

This is pre-event core work. It must not be presented as work created during
the official event.

## Competition-day feature

The small but real post-start feature is:

> **Judge Challenge Mode**
>
> A judge chooses a physical fault and watches the existing safety gate prove
> why the highest-scoring unsafe firmware cannot ship.

**Pre-event status:** reserved and not implemented.

API-key injection, configuration changes, provider smoke runs, and evidence
capture are launch work, not the new feature.

## Bounded implementation

After the official hacking window opens:

1. Add a disabled-by-default `SAFEFLASH_JUDGE_CHALLENGE_ENABLED` flag.
2. Add a compact selector with exactly two server-owned choices:
   `battery-sensor-disconnect` and `motor-command-nonfinite`.
3. Add a server endpoint that accepts only that enum and maps it to the
   existing immutable profile registry.
4. Run the chosen simulated-device tournament with the existing fixed command
   policy and hard-gate selector.
5. Return a sanitized challenge receipt binding profile ID/version, source
   commit, winner, rejected higher score, evidence digests, and local-test
   provenance.
6. Display `SIMULATED DEVICE` and `LOCAL-TEST · NOT LIVE` unless an entirely
   separate authorized provider run supplies genuine Live evidence.

The feature must not accept caller-supplied paths, commands, policies, test
counts, candidates, or thresholds.

## Day-of tests and commit

- feature flag off: no challenge controls or endpoint mutation;
- invalid profile ID: `400`, no execution;
- Battery challenge: higher unsafe score rejected;
- Motor challenge: higher unsafe score rejected;
- no provider calls, PR creation, push, merge, or real hardware requirement;
- Playwright selector-to-receipt flow;
- TypeScript, unit/integration, production build, secret scan, P0, rehearsal.

Create a clearly post-start commit such as:

```text
feat: add judge-selected physical fault challenge
```

Retain the commit time, test log, screenshots, and SHA-256 evidence manifest.

## Allowed day-of claim

Only after the post-start implementation and tests pass:

> During this HackSprint we added Judge Challenge Mode, so a judge can choose
> between Battery and Motor faults and see the same evidence-first safety gate
> reject a higher-scoring unsafe patch.

Do not claim:

- physical hardware or HIL validation;
- universal firmware safety;
- Live providers for a local/mock challenge;
- that the pre-event cross-device engine was built during the event.

## Policy Composer

Safety Policy Composer remains a disabled roadmap item. It is not an active
natural-language-to-policy converter and cannot authorize a safety transition.
SafeFlash continues to rely on repository-owned, engineer-reviewed executable
policies.
