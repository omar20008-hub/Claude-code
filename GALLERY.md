# AI Workforce Platform - Gallery

Interactive gallery showcasing all 11 screens of the AI Workforce bilingual SaaS platform.

## Overview

The gallery provides a comprehensive walkthrough of every screen in the application, with detailed descriptions of features and functionality in both Arabic (RTL) and English (LTR).

## Screens

### 1. **Login** 🔐
- Email & password authentication
- Organization creation on signup
- Language toggle (accessible before login)
- Single transaction creates org + first admin

### 2. **Dashboard** 📊
- 5 KPI tiles (agents used, assets, campaigns, active agents, health)
- Agent status cards
- n8n & storage integration status
- Real-time metrics

### 3. **AI Agents** 🤖
- Knowledge Agent: Q&A from indexed Google Drive
- Creative Agent: Image generation in multiple aspect ratios
- Advertising Agent: Meta campaign creation wizard
- Real capabilities from n8n workflow metadata

### 4. **Knowledge** 📚
- Chat interface with Knowledge Agent
- Real-time message streaming
- Sources panel with cited documents
- Citation parsing from workflow output

### 5. **Creative Studio** 🎨
- Image generation with text prompts
- Multiple aspect ratio options (1:1, 4:3, 16:9, 9:16)
- Auto-save to asset library
- Generation history & batch creation

### 6. **Campaign Wizard** 📢
- 8-step guided workflow for Meta campaigns
- Campaign objective, audience, budget, schedule
- Creative selection & pre-launch review
- Campaigns created in PAUSED state (no auto-spend)

### 7. **Campaigns** 📋
- Table view of all campaigns
- Lifecycle states: Draft, Ready, Launching, Active, Paused, Failed
- Filter by status & date
- Idempotency guards against duplicates

### 8. **Analytics** 📈
- Agent activity timeline (hand-built SVG)
- Correct RTL/LTR axis rendering
- Campaign performance metrics
- Clear indication of missing integrations

### 9. **Assets** 🖼️
- Gallery of generated images & videos
- Filter by type, campaign, date
- S3 presigned URLs for secure preview
- Tenant-isolated access

### 10. **Activity** 📝
- Immutable append-only audit trail
- Localized action descriptions (stable keys)
- Full compliance history
- Cannot be modified or deleted

### 11. **Settings** ⚙️
- Organization details & language settings
- Timezone configuration
- Password management
- Integration status & credential locations

## Gallery Features

- **Bilingual**: Arabic (RTL) and English (LTR) with CSS logical properties
- **Interactive**: Click to navigate between screens
- **Responsive**: Adapts to different screen sizes
- **Theme-aware**: Supports light and dark modes
- **Detailed Previews**: Each screen shows key features and capabilities

## Files

- `.gallery.template.html` - Main gallery template with detailed preview content for all 11 screens
- `GALLERY.md` - This documentation file

## Building with Real Screenshots

To populate the gallery with actual screenshots from the running application:

1. **Run the application locally:**
   ```bash
   npm run dev
   ```

2. **Capture screenshots using Playwright:**
   ```bash
   npm run test:e2e -- --update-snapshots
   ```
   Or manually capture at 1440×950 with 2× device pixel ratio

3. **Convert images to Base64:**
   ```bash
   node -e "console.log('data:image/jpeg;base64,' + require('fs').readFileSync('screenshot.jpg', 'base64'))"
   ```

4. **Populate the IMAGES object:**
   In `.gallery.template.html`, replace the `{{IMAGES}}` placeholder with:
   ```javascript
   const IMAGES = {
     'ar-01-login': 'data:image/jpeg;base64,...',
     'en-01-login': 'data:image/jpeg;base64,...',
     // ... for each screen in both languages
   };
   ```

## Deployment

The gallery template is ready to be:
- Published on a static server
- Deployed as part of the main documentation site
- Included in marketing materials
- Used for user onboarding & training

## Notes

- The gallery is theme-aware and respects system preferences
- All text is properly localized and directional
- Screenshots should be taken from the production build for consistency
- Presigned URLs in the Assets screen ensure secure access to user files

---

**Last Updated:** September 2026  
**Status:** Complete with all 11 screens documented
