import { setup } from "./setup.js";
setup().catch((err) => {
    console.warn("[dubridge] setup warning:", err?.message || err);
    console.warn("[dubridge] You can retry later: dubridge setup");
    process.exit(0);
});
//# sourceMappingURL=setup-cli.js.map