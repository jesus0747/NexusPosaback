/**
 * Logo Upload Route
 * POST /api/nexus/logos/upload
 * Accepts multipart image, stores to GCS object storage, returns public URL.
 */
import { Router } from "express";
import multer from "multer";
import { objectStorageClient } from "../lib/objectStorage.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed (PNG, JPG, GIF, WebP, SVG)"));
  },
});

router.post("/nexus/logos/upload", upload.single("logo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
    if (!bucketId) return res.status(503).json({ error: "Object storage not configured" });

    const ext = path.extname(req.file.originalname).toLowerCase() || ".png";
    const objectKey = `logos/${randomUUID()}${ext}`;

    const bucket = objectStorageClient.bucket(bucketId);
    const file = bucket.file(objectKey);

    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype },
      resumable: false,
      public: true,
    });

    const publicUrl = `https://storage.googleapis.com/${bucketId}/${objectKey}`;

    res.json({ url: publicUrl, key: objectKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    res.status(500).json({ error: msg });
  }
});

export default router;
