const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    externalId: {
      type: String,
      required: true,
      index: true,
    },
    platform: {
      type: String,
      required: true,
      enum: [
        'chatgpt', 'claude', 'gemini',
        'deepseek', 'blackbox', 'copilot', 'mscopilot',
        'perplexity', 'grok',
        'brain-shadow',
      ],
      lowercase: true,
      trim: true,
    },
    title: {
      type: String,
      trim: true,
    },
    messages: [
      {
        role: String,
        content: String,
        timestamp: String,
      },
    ],
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETRYING'],
      default: 'PENDING',
      index: true,
    },
    // ── Platform timestamps (added for timestamp pipeline) ──────
    timestamps: {
      created_at:  Date,
      published_at: Date,
      updated_at:   Date,
      edited_at:    Date,
      scraped_at:   Date,
    },
    timestamp_source:     String,
    timestamp_confidence: String,
    original_timezone:    String,
    timestamp_raw:        String,
    // ── End timestamp fields ────────────────────────────────────
    enrichment: {
      topic: String,
      category: String,
      summary: String,
      keywords: [String],
      entities: [String],
      importanceScore: Number,
      enrichedAt: Date,
      version: String,
      // messages.length at the time enrichment ran. Lets us tell a genuinely
      // up-to-date summary apart from one that's stale because the
      // conversation grew after it was last enriched.
      messageCountAtEnrichment: Number,
    },
    error: {
      type: String,
    },
    metadata: {
      topic: String,
      category: String,
      summary: String,
      keywords: [String],
      entities: [String],
      importance_score: Number,
      enriched_at: Date,
      enrichment_version: String,
      status: String,
      savedAtExtension: String,
      url: String,
    },
  },
  {
    timestamps: true,
  }
);

// IDs only need to be unique inside their source platform and per user.
conversationSchema.index({ userId: 1, platform: 1, externalId: 1 }, { unique: true });

module.exports = mongoose.model('Conversation', conversationSchema);
