import Link from "next/link";

import { readSafetyPolicyComposerReservation } from "@safeflash/domain";

export const dynamic = "force-dynamic";

export default function SafetyPolicyComposerPage() {
  const reservation = readSafetyPolicyComposerReservation(process.env);

  return (
    <main
      aria-labelledby="policy-composer-title"
      data-feature-enabled={String(reservation.enabled)}
      style={{
        display: "grid",
        minHeight: "100dvh",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <section
        style={{
          maxWidth: "46rem",
          padding: "2rem",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
        }}
      >
        <p className="eyebrow">DAY-OF FEATURE RESERVATION</p>
        <h1 id="policy-composer-title">Safety Policy Composer</h1>
        <p>
          Reserved for HackSprint day-of implementation. Policy conversion is
          not implemented in this build, and this page cannot change the
          certified safety policy.
        </p>
        <p>
          Feature flag:{" "}
          <strong>{reservation.enabled ? "ENABLED EMPTY STATE" : "OFF"}</strong>
        </p>
        <p>
          Conversion availability: <strong>NOT IMPLEMENTED</strong>
        </p>
        <Link href="/">Return to SafeFlash</Link>
      </section>
    </main>
  );
}
