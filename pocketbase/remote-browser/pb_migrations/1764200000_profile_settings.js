/// <reference path="../pb_data/types.d.ts" />

// Per profile browser settings. Empty values mean the app default (see browser/manager.ts).

migrate(
  (app) => {
    const profiles = app.findCollectionByNameOrId("profiles")
    profiles.fields.add(
      new SelectField({ name: "engine", values: ["chromium", "firefox", "webkit"], maxSelect: 1 }),
    )
    profiles.fields.add(new SelectField({ name: "device", values: ["desktop", "mobile"], maxSelect: 1 }))
    profiles.fields.add(new TextField({ name: "locale", max: 20 }))
    profiles.fields.add(new TextField({ name: "timezone", max: 64 }))
    profiles.fields.add(
      new SelectField({ name: "color_scheme", values: ["light", "dark"], maxSelect: 1 }),
    )
    profiles.fields.add(new BoolField({ name: "stealth" }))
    profiles.fields.add(new TextField({ name: "proxy", max: 300 }))
    app.save(profiles)
  },
  (app) => {
    const profiles = app.findCollectionByNameOrId("profiles")
    for (const name of ["engine", "device", "locale", "timezone", "color_scheme", "stealth", "proxy"]) {
      profiles.fields.removeByName(name)
    }
    app.save(profiles)
  },
)
