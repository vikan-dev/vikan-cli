/// <reference path="./resources-text.d.ts" />
import upstreamBundle from "../../vendor/answer-me-with-html/am.mjs" with { type: "text" };
import upstreamLicense from "../../vendor/answer-me-with-html/LICENSE.txt" with { type: "text" };
import thirdPartyNotices from "../../vendor/answer-me-with-html/THIRD_PARTY_NOTICES.txt" with { type: "text" };
import provenance from "../../vendor/answer-me-with-html/provenance.json";
import cliLicense from "../../LICENSE" with { type: "text" };
import dependencyNotices from "../../THIRD_PARTY_NOTICES.md" with { type: "text" };

// The text loader embeds these resources in the single-file CLI. Never import
// am.mjs as executable code: it is run only inside the isolated render process.
export const bundleSource: string = upstreamBundle;
export const rendererCommit: string = provenance.commit;
export const rendererLicenses: string = [
  "vikan CLI",
  cliLicense,
  dependencyNotices,
  "",
  `answer-me-with-html ${provenance.version}`,
  `Source: ${provenance.repository}`,
  `Commit: ${rendererCommit}`,
  `Bundle SHA-256: ${provenance.bundle.sha256}`,
  "",
  upstreamLicense,
  thirdPartyNotices,
].join("\n");
