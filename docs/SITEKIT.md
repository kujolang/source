# Source UI and Kujo SiteKit

Source vendors the generated Kujo SiteKit 1.0 distribution under
`assets/sitekit/`. The server exposes the CSS, progressive behavior, fonts, and
manifest at `/assets/sitekit/`; `assets/source.css` contains only Source-specific
page composition and consumes SiteKit tokens.

Use SiteKit primitives when changing the UI:

- `sk-card`, `sk-content-section`, and `sk-grid` for layout and surfaces;
- `sk-form`, `sk-form-field`, and `sk-button` for controls;
- `sk-navigation`, `sk-table`, `sk-badge`, and `sk-alert` for application chrome;
- `data-theme="kujo-light"` / `data-theme="kujo-dark"` for theme selection.

To update the vendored release from the sibling SiteKit checkout:

```bash
(cd ../site-kit && npm run build)
rm -rf assets/sitekit
mkdir -p assets/sitekit
cp ../site-kit/dist/sitekit.css ../site-kit/dist/sitekit.js ../site-kit/dist/sitekit-manifest.json assets/sitekit/
cp -R ../site-kit/dist/fonts assets/sitekit/
npm test
```

Commit the generated distribution and the Source composition changes together
so the UI always has a complete, reviewable design-system artifact.
