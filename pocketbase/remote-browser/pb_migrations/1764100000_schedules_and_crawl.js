/// <reference path="../pb_data/types.d.ts" />

// Cron schedules on jobs, run trigger and item count on runs, and the crawl_items store.

migrate(
  (app) => {
    const jobs = app.findCollectionByNameOrId("jobs")
    jobs.fields.add(new TextField({ name: "schedule", max: 100 }))
    jobs.fields.add(new BoolField({ name: "enabled" }))
    app.save(jobs)

    const runs = app.findCollectionByNameOrId("job_runs")
    runs.fields.add(
      new SelectField({ name: "trigger", values: ["manual", "schedule", "mcp"], maxSelect: 1 }),
    )
    runs.fields.add(new NumberField({ name: "items", onlyInt: true, min: 0 }))
    app.save(runs)

    const items = new Collection({
      type: "base",
      name: "crawl_items",
      fields: [
        {
          name: "job",
          type: "relation",
          collectionId: jobs.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        {
          name: "run",
          type: "relation",
          collectionId: runs.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        { name: "data", type: "json", maxSize: 100000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      ],
      indexes: [
        "CREATE INDEX idx_crawl_items_job ON crawl_items (job, created)",
        "CREATE INDEX idx_crawl_items_run ON crawl_items (run)",
      ],
    })
    app.save(items)
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("crawl_items"))
    const runs = app.findCollectionByNameOrId("job_runs")
    runs.fields.removeByName("trigger")
    runs.fields.removeByName("items")
    app.save(runs)
    const jobs = app.findCollectionByNameOrId("jobs")
    jobs.fields.removeByName("schedule")
    jobs.fields.removeByName("enabled")
    app.save(jobs)
  },
)
