/// <reference path="../pb_data/types.d.ts" />

// Markdown documents (Obsidian-like notes) and stored images (captures, uploads, job screenshots).

migrate(
  (app) => {
    const docs = new Collection({
      type: "base",
      name: "docs",
      fields: [
        { name: "title", type: "text", required: true, max: 200 },
        { name: "body", type: "text", max: 1000000 },
        { name: "tags", type: "json", maxSize: 5000 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_docs_title ON docs (title)"],
    })
    app.save(docs)

    const jobs = app.findCollectionByNameOrId("jobs")
    const runs = app.findCollectionByNameOrId("job_runs")
    const images = new Collection({
      type: "base",
      name: "images",
      fields: [
        {
          name: "file",
          type: "file",
          required: true,
          maxSelect: 1,
          maxSize: 20 * 1024 * 1024,
          mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
          protected: true,
        },
        { name: "title", type: "text", max: 200 },
        { name: "source", type: "select", values: ["capture", "upload", "job", "mcp"], maxSelect: 1 },
        { name: "page_url", type: "text", max: 2000 },
        { name: "job", type: "relation", collectionId: jobs.id, maxSelect: 1, cascadeDelete: false },
        { name: "run", type: "relation", collectionId: runs.id, maxSelect: 1, cascadeDelete: false },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      ],
      indexes: ["CREATE INDEX idx_images_created ON images (created)"],
    })
    app.save(images)
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("images"))
    app.delete(app.findCollectionByNameOrId("docs"))
  },
)
