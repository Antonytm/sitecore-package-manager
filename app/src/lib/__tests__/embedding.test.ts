// Who is hosting the iframe, decided from what a child frame is actually allowed to see.
//
// The cases that matter are the ones a developer hits daily: the real portal, a localhost dev
// server opened directly in a tab, and a local extension URL embedded by the portal. None of
// them is an error state — the bar reports which, it does not judge.

import { describe, it, expect } from "vitest";
import {
  PORTAL_ORIGIN,
  describeEmbedding,
  type EmbeddingProbe,
} from "../embedding";

const probe = (over: Partial<EmbeddingProbe> = {}): EmbeddingProbe => ({
  isTop: false,
  ancestorOrigins: [],
  referrer: "",
  appOrigin: "https://sitecore-package-manager.netlify.app",
  ...over,
});

describe("the real portal", () => {
  it("recognises app.sitecorecloud.io as the portal", () => {
    const info = describeEmbedding(probe({ ancestorOrigins: [PORTAL_ORIGIN] }));
    expect(info.kind).toBe("portal");
    expect(info.embedded).toBe(true);
    expect(info.label).toBe("app.sitecorecloud.io");
    expect(info.detectedVia).toBe("ancestorOrigins");
  });

  it("still recognises it from the referrer where ancestorOrigins is unimplemented", () => {
    // Firefox has no location.ancestorOrigins at all, so the referrer is the only channel.
    const info = describeEmbedding(
      probe({ referrer: PORTAL_ORIGIN + "/marketplace/app/1234?organization=org_x" }),
    );
    expect(info.kind).toBe("portal");
    expect(info.hostOrigin).toBe(PORTAL_ORIGIN);
    expect(info.detectedVia).toBe("referrer");
  });

  it("prefers ancestorOrigins over the referrer", () => {
    // The referrer describes the navigation that created the document and can be stale;
    // ancestorOrigins is current. Disagreement must resolve to the current one.
    const info = describeEmbedding(
      probe({
        ancestorOrigins: ["http://localhost:4000"],
        referrer: PORTAL_ORIGIN + "/",
      }),
    );
    expect(info.hostOrigin).toBe("http://localhost:4000");
    expect(info.detectedVia).toBe("ancestorOrigins");
    expect(info.kind).toBe("other");
  });
});

describe("other Sitecore hosts", () => {
  it.each([
    "https://pages.sitecorecloud.io",
    "https://xmapps.sitecorecloud.app",
    "https://portal.sitecore-staging.cloud",
  ])("treats %s as Sitecore but not the production portal", (origin) => {
    expect(describeEmbedding(probe({ ancestorOrigins: [origin] })).kind).toBe("sitecore-other");
  });

  it("does not match a lookalike domain by substring", () => {
    // The SDK's own AllowedOrigins check is `includes`, which would accept this. Matching on
    // the hostname boundary instead is the difference between a label and a lie.
    const info = describeEmbedding(
      probe({ ancestorOrigins: ["https://sitecorecloud.io.evil.test"] }),
    );
    expect(info.kind).toBe("other");
  });
});

describe("running locally", () => {
  it("reports a dev server opened directly in a tab as not embedded", () => {
    const info = describeEmbedding(
      probe({ isTop: true, appOrigin: "http://localhost:3000" }),
    );
    expect(info.embedded).toBe(false);
    expect(info.kind).toBe("not-embedded");
    expect(info.label).toBe("not embedded · localhost:3000");
    expect(info.appIsLocal).toBe(true);
  });

  it("keeps the port, because that is what distinguishes two local servers", () => {
    const info = describeEmbedding(probe({ ancestorOrigins: ["http://localhost:4000"] }));
    expect(info.label).toBe("localhost:4000");
  });

  it("flags a localhost extension URL embedded by the real portal", () => {
    // The everyday dev setup: the portal hosts us, but the code is served from the machine.
    // Host and app must be reported separately or this reads as a production run.
    const info = describeEmbedding(
      probe({ ancestorOrigins: [PORTAL_ORIGIN], appOrigin: "https://localhost:3000" }),
    );
    expect(info.kind).toBe("portal");
    expect(info.appIsLocal).toBe(true);
  });

  it.each(["http://127.0.0.1:3000", "http://[::1]:3000"])(
    "counts %s as a local app origin",
    (appOrigin) => {
      expect(describeEmbedding(probe({ isTop: true, appOrigin })).appIsLocal).toBe(true);
    },
  );

  it("does not call a deployed origin local", () => {
    expect(describeEmbedding(probe({ isTop: true })).appIsLocal).toBe(false);
  });
});

describe("when nothing answers", () => {
  it("says the host is unknown rather than guessing", () => {
    // Embedded, no ancestorOrigins, referrer stripped by policy. Reporting "other" here would
    // claim knowledge we do not have.
    const info = describeEmbedding(probe());
    expect(info.kind).toBe("unknown");
    expect(info.hostOrigin).toBeUndefined();
    expect(info.detectedVia).toBe("none");
    expect(info.label).toBe("embedded · host unknown");
  });

  it.each(["", "about:blank", "not a url"])("ignores %o as a referrer", (referrer) => {
    expect(describeEmbedding(probe({ referrer })).kind).toBe("unknown");
  });

  it("skips an unparseable ancestor entry and falls back to the referrer", () => {
    const info = describeEmbedding(
      probe({ ancestorOrigins: ["null"], referrer: PORTAL_ORIGIN + "/" }),
    );
    expect(info.detectedVia).toBe("referrer");
    expect(info.kind).toBe("portal");
  });

  it("uses the nearest ancestor, not the outermost", () => {
    // Nested frames: the immediate parent is what embedded us and what we can name.
    const info = describeEmbedding(
      probe({ ancestorOrigins: ["https://inner.example.test", PORTAL_ORIGIN] }),
    );
    expect(info.hostOrigin).toBe("https://inner.example.test");
  });
});
