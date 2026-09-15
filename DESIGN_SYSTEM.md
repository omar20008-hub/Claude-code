# AI Workforce Design System

Professional SaaS design based on FlowMail aesthetic with green brand color and bilingual Arabic/English RTL support.

## 🎨 Design Principles

### Visual Hierarchy
- Use clear typography scale (headers, body, labels)
- Distinguish primary actions from secondary ones
- Give whitespace intentional purpose
- Maintain consistent spacing between sections

### Color Palette
- **Brand Color**: #10b981 (Emerald Green) - used for active states, CTAs, and highlights
- **Dark Sidebar**: #1f2937 to #111827 gradient - professional, contained navigation
- **Light Backgrounds**: #f8fafc (slate-50) - clean, readable content areas
- **Neutral Grays**: Full grayscale for text hierarchy and borders

### Typography
- **Display**: Large, bold headings (24px+) for page titles
- **Headline**: 18px semi-bold for section titles
- **Body**: 14px regular for content
- **Label**: 12-13px font-medium for form labels and metric titles
- **Monospace**: For technical values, IDs, and code

### Spacing
- Base unit: 4px (tailwind default)
- Card padding: 24px (6 units)
- Section margins: 32px (8 units)
- Gap between cards: 24px

### Shadows
- **Subtle**: `shadow-sm` - small cards, secondary elements
- **Medium**: `shadow-md` - main content cards, interactive elements
- **Elevated**: `shadow-lg` - modal overlays, dropdowns

## 🏗️ Component Architecture

### Layout Components

#### AppShell
Dark sidebar layout with top header, found in `src/components/app-shell.tsx`

**Features:**
- Dark gradient sidebar (#1f2937 to #111827)
- Navigation sections with grouped menu items
- Active state highlighting in emerald green (#10b981)
- User card with sign-out action
- Mobile responsive drawer
- Light page background for content
- RTL/LTR logical properties support

**Usage:**
All authenticated pages use AppShell via `src/app/[locale]/(app)/layout.tsx`

#### PageHeader
Title and description for page sections

```tsx
<PageHeader
  title="Dashboard"
  description="Welcome back, user"
/>
```

### Card Components

#### Card
Container for grouped content

**Properties:**
- Background: White (surface-card)
- Border: 1px solid border-subtle
- Radius: var(--radius-card) (14px)
- Padding: 24px
- Shadow: shadow-md for emphasis

**Usage in Dashboard:**
All metric cards, section cards use this pattern

```tsx
<Card className="shadow-md">
  <CardHeader title="Section Title" />
  <CardBody>
    {/* Content */}
  </CardBody>
</Card>
```

#### MetricCard (Dashboard Pattern)
Displays a single metric with label and value

**Structure:**
- Label: 12px uppercase gray text
- Value: 24px bold colored text
- Optional tone: success (green), danger (red), warning (yellow)
- Hover state: increased shadow

**Styling:**
```tsx
<div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 shadow-sm hover:shadow-md transition-shadow">
  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
    Label
  </p>
  <p className="mt-2 text-2xl font-bold text-[var(--text-primary)]">
    Value
  </p>
</div>
```

### Form Components

#### Input Fields
All form inputs use consistent styling

**Properties:**
- Height: 36px (px-3 py-2)
- Border: 1px border-strong
- Radius: var(--radius-control) (10px)
- Focus: border-color to brand, box-shadow with brand opacity
- Font: 14px regular

**Focus State:**
```css
input:focus {
  border-color: var(--color-brand-600);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.1);
}
```

#### Auth Pages
Standalone centered card layout

**Pattern:**
- Full viewport height
- Centered card with max-width: 480px
- Gradient background (from-slate-50 to-green-50)
- Card shadow: shadow-lg
- All fields same width as card

**Template:**
```tsx
<div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-br from-slate-50 to-green-50">
  <Card className="w-full max-w-md shadow-lg">
    <CardBody className="space-y-6 p-12">
      {/* Content */}
    </CardBody>
  </Card>
</div>
```

## 📱 Pages & Patterns

### Authentication Pages
- **Location**: `src/app/[locale]/(auth)/`
- **Files**: `login-form.tsx`, `register-form.tsx`
- **Pattern**: Centered card with gradient background
- **Status**: ✅ Updated with FlowMail design

### Dashboard Page
- **Location**: `src/app/[locale]/(app)/dashboard/page.tsx`
- **Pattern**: Multi-section layout with metric cards
- **Status**: ✅ Updated with enhanced styling
- **Key Components**: Metric cards, Section cards, Status badges

### Agent Pages
- **Locations**:
  - `src/app/[locale]/(app)/agents/page.tsx`
  - `src/app/[locale]/(app)/knowledge/page.tsx`
  - `src/app/[locale]/(app)/creative/page.tsx`
  - `src/app/[locale]/(app)/advertising/page.tsx`
- **Pattern**: Grid/list of agent cards with actions
- **Status**: ⏳ Ready for design system application

### Analytics Page
- **Location**: `src/app/[locale]/(app)/analytics/page.tsx`
- **Pattern**: Filters, charts, performance table
- **Status**: ⏳ Ready for design system application

### Settings Page
- **Location**: `src/app/[locale]/(app)/settings/page.tsx`
- **Pattern**: Form sections with grouped inputs
- **Status**: ⏳ Ready for design system application

## 🎯 Implementation Checklist

### Phase 1: Foundation ✅
- [x] Update AppShell sidebar styling
- [x] Update auth pages (login/register)
- [x] Enhance dashboard metrics

### Phase 2: Main Pages 🔄
- [ ] Agent management pages (Knowledge, Creative, Advertising)
- [ ] Analytics and reporting page
- [ ] Settings and configuration page
- [ ] Campaign management pages
- [ ] Asset library pages
- [ ] Activity/history pages

### Phase 3: Polish ✅
- [x] Design system documentation (this file)
- [ ] Component storybook/reference
- [ ] Accessibility audit
- [ ] RTL/bilingual testing
- [ ] Dark mode testing

## 🌙 Dark Mode Support

All colors use CSS variables that respect `data-theme="dark"` attribute.

**Light Mode** (default):
- Page background: #f8fafc (slate-50)
- Card background: #ffffff (white)
- Text: #1f2937 (gray-800)

**Dark Mode**:
- Page background: #0f172a (slate-950)
- Card background: #1f2937 (gray-900)
- Text: #f1f5f9 (slate-100)

**Variable Definition** (`src/app/globals.css`):
```css
:root {
  --surface-page: oklch(0.985 0.002 250);
  --text-primary: oklch(0.24 0.012 250);
}

:root[data-theme='dark'] {
  --surface-page: oklch(0.178 0.010 250);
  --text-primary: oklch(0.965 0.003 250);
}
```

## 🌍 RTL/Bilingual Support

### Logical Properties (Always Use)
```css
/* ✅ Good - works in both LTR and RTL */
margin-inline-start: 16px;  /* left in LTR, right in RTL */
padding-inline-end: 8px;    /* right in LTR, left in RTL */
border-inline-start: 1px;   /* left in LTR, right in RTL */

/* ❌ Avoid - direction-specific */
margin-left: 16px;
padding-right: 8px;
border-left: 1px;
```

### Direction-Specific Content
For icons that point (arrows, chevrons), use `data-flip-rtl` attribute:

```tsx
<svg data-flip-rtl>
  {/* Arrow will mirror in RTL */}
</svg>
```

### Type Stacks
- **Arabic**: 'Noto Kufi Arabic', 'Cairo', fallbacks
- **Latin**: 'Inter', system fonts
- **Mono**: 'JetBrains Mono', fallbacks

## 📐 Spacing Reference

| Space | Value | Usage |
|-------|-------|-------|
| xs | 4px | Micro spacing, icon gaps |
| sm | 8px | Component padding, small gaps |
| md | 12px | Element spacing |
| base | 16px | Standard padding |
| lg | 24px | Card padding, section gaps |
| xl | 32px | Major section breaks |
| 2xl | 48px | Page sections |

## 🔗 Related Files

- **Tokens**: `src/app/globals.css` - CSS variable definitions
- **AppShell**: `src/components/app-shell.tsx` - Navigation layout
- **Primitives**: `src/components/ui/primitives.tsx` - Base components
- **Icons**: `src/components/ui/icons.tsx` - Icon set
- **Themes**: `src/components/theme-toggle.tsx` - Dark mode toggle

## 🎬 Design Canvas

View the interactive design system at: https://claude.ai/artifact/9Kqv9kCrCMGkvmpiqeVnVW

Includes:
- Dashboard page mockup
- Login/Register page mockup
- Analytics page mockup
- Component patterns
- Color and typography reference

## 📝 Maintenance

### Adding New Pages
1. Use AppShell layout (authenticated pages)
2. Follow Card + CardHeader + CardBody patterns
3. Use design tokens from globals.css
4. Test in both light and dark modes
5. Test with Arabic/English text
6. Check RTL layout with logical properties

### Color Changes
Edit CSS variables in `src/app/globals.css`:
```css
--color-brand-600: oklch(0.524 0.114 158); /* Green */
```

### Typography Changes
Edit font stacks and sizes in globals.css:
```css
--font-latin: 'Inter', system-ui, sans-serif;
```

---

**Last Updated**: 2026-09-15
**Version**: 1.0
**Status**: Active Development
