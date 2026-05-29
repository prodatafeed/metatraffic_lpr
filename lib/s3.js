const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs   = require('fs');
const path = require('path');

// Lazy-initialise so the app starts even if S3 vars aren't set yet
let _client = null;
function client() {
  if (!_client) {
    _client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

const BUCKET = () => process.env.AWS_S3_BUCKET;

/**
 * Upload a local JPEG file to S3.
 *
 * @param {string} localPath  Absolute path to the file on disk
 * @param {string} s3Key      Full S3 object key, e.g. LPR/LOC-001/2026-05-27/guid.jpg
 * @returns {Promise<string>} Public HTTPS URL of the uploaded object
 */
async function uploadPhoto(localPath, s3Key) {
  if (!BUCKET()) throw new Error('AWS_S3_BUCKET is not configured');

  const body = fs.createReadStream(localPath);
  await client().send(new PutObjectCommand({
    Bucket:      BUCKET(),
    Key:         s3Key,
    Body:        body,
    ContentType: 'image/jpeg',
  }));

  const region = process.env.AWS_REGION || 'us-east-1';
  return `https://${BUCKET()}.s3.${region}.amazonaws.com/${s3Key}`;
}

/**
 * Build the S3 key for a photo given the LPR read details.
 *
 * Path: LPR/<LOCATION_CODE>/<YYYY-MM-DD>/<guid>.jpg
 *
 * @param {string} guid
 * @param {string|null} locationCode
 * @param {string|null} timestamp   ISO string or anything Date() can parse
 * @returns {string}
 */
function buildS3Key(guid, locationCode, timestamp) {
  // Sanitise location code — keep alphanumerics, dash, underscore only
  const loc  = (locationCode || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  const date = new Date(timestamp || Date.now()).toISOString().slice(0, 10); // YYYY-MM-DD
  return `LPR/${loc}/${date}/${guid}.jpg`;
}

module.exports = { uploadPhoto, buildS3Key };
