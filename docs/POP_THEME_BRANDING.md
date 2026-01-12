# EditMuse Pop Theme Branding Guide

Complete branding specification for the **Pop (Gen-Z)** theme style used throughout EditMuse.

---

## 🎨 Color Palette

### Primary Colors
- **Accent Color (Primary)**: `#7C3AED` (Purple/Violet)
  - RGB: `rgb(124, 58, 237)`
  - RGBA: `rgba(124, 58, 237, 1.0)`
  - Used for: Primary buttons, borders, highlights, shadows

- **Accent Color 2 (Secondary)**: `#06B6D4` (Cyan/Turquoise)
  - RGB: `rgb(6, 182, 212)`
  - RGBA: `rgba(6, 182, 212, 1.0)`
  - Used for: Gradient endpoints, secondary highlights

### Neutral Colors
- **Surface**: `#FFFFFF` (White)
- **Text**: `#0B0B0F` (Near Black)
  - RGB: `rgb(11, 11, 15)`
- **Muted Text**: `rgba(11, 11, 15, 0.62)` (62% opacity)
- **Border**: `rgba(11, 11, 15, 0.14)` (14% opacity)

---

## 🌈 Gradients

### Primary Gradient
```css
background: linear-gradient(135deg, #7C3AED, #06B6D4);
```
- **Direction**: 135 degrees (diagonal from top-left to bottom-right)
- **Start**: Purple (`#7C3AED`)
- **End**: Cyan (`#06B6D4`)
- **Usage**: Buttons, banners, highlights, cards

### Subtle Gradient (Backgrounds)
```css
background: linear-gradient(135deg, rgba(124, 58, 237, 0.1), rgba(6, 182, 212, 0.1));
```
- **Opacity**: 10% for subtle backgrounds
- **Usage**: Section backgrounds, card backgrounds

### Medium Gradient (Borders/Highlights)
```css
background: linear-gradient(135deg, rgba(124, 58, 237, 0.15), rgba(6, 182, 212, 0.15));
```
- **Opacity**: 15% for medium emphasis
- **Usage**: Enhanced sections, feature highlights

---

## 📐 Design Tokens

### Border Radius
- **Default**: `18px` (rounded corners)
- **Buttons**: `14px` (slightly less rounded)
- **Cards**: `12px` (consistent with pop theme)
- **Modal**: `22px` (maximum roundness for pop style)

### Spacing
- **Default**: `16px` (base unit)
- **Compact**: `14px` (tighter spacing when needed)
- **Expanded**: `20px` (more breathing room)

### Shadows

#### Soft Shadow (Default)
```css
box-shadow: 0 2px 8px rgba(124, 58, 237, 0.1);
```
- **Usage**: Cards, metric boxes, subtle elevation

#### Medium Shadow
```css
box-shadow: 0 4px 12px rgba(124, 58, 237, 0.2);
```
- **Usage**: Banners, important sections

#### Strong Shadow
```css
box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
```
- **Usage**: Modals, prominent cards, buttons

#### Enhanced Modal Shadow (Pop Style)
```css
box-shadow: 
  0 24px 72px rgba(0, 0, 0, 0.32),
  0 0 0 1px rgba(255, 255, 255, 0.6),
  0 0 40px color-mix(in srgb, #7C3AED 35%, transparent);
```
- **Usage**: Pop-themed modals (concierge widget)
- **Effect**: Deep shadow with purple glow

---

## 🎯 Component Styles

### Buttons

#### Primary Button (Solid)
```css
background: linear-gradient(135deg, #7C3AED, #06B6D4);
color: #FFFFFF;
border-radius: 12px;
box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
border: none;
```

#### Button Hover State
- Slight scale/glow effect
- Enhanced shadow

### Banners/Alerts

#### Success Banner
```css
background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(6, 182, 212, 0.1));
border: 2px solid rgba(16, 185, 129, 0.3);
border-radius: 12px;
box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2);
color: #059669;
```

#### Info/Upsell Banner
```css
background: linear-gradient(135deg, #7C3AED, #06B6D4);
border: 2px solid rgba(124, 58, 237, 0.5);
border-radius: 12px;
box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
color: #FFFFFF;
```

### Cards

#### Metric Card
```css
background-color: #FFFFFF;
border: 1px solid rgba(11, 11, 15, 0.12);
border-radius: 12px;
box-shadow: 0 2px 8px rgba(124, 58, 237, 0.1);
padding: 1rem;
```

#### Plan Card
```css
background-color: #FFFFFF;
border: 2px solid rgba(124, 58, 237, 0.2);
border-radius: 12px;
box-shadow: 0 4px 12px rgba(124, 58, 237, 0.15);
padding: 1.5rem;
```

### Status Badges

#### Active/Enabled
```css
background: linear-gradient(135deg, rgba(124, 58, 237, 0.1), rgba(6, 182, 212, 0.1));
border: 2px solid rgba(124, 58, 237, 0.3);
border-radius: 12px;
color: #7C3AED;
```

---

## 🎭 Brand Style Characteristics

### Visual Identity
- **Style**: Gen-Z Pop, vibrant, energetic
- **Mood**: Modern, playful, engaging
- **Aesthetic**: Bold gradients, rounded corners, soft shadows with purple glow

### Key Features
- ✅ **Gradients Enabled**: Always use gradients for primary elements
- ✅ **Rounded Corners**: Generous border radius (18-22px)
- ✅ **Purple Glow**: Shadows include purple tint
- ✅ **High Contrast**: White surfaces with dark text
- ✅ **Bold Accents**: Purple and cyan as primary colors

### Typography
- **Font Scale**: `1.04` (slightly larger for pop style)
- **Text Color**: `#0B0B0F` (near black)
- **Muted Text**: `rgba(11, 11, 15, 0.62)` (62% opacity)

### Interactive Elements
- **Button Variant**: `solid` (filled, not outline)
- **Button Radius**: `14px`
- **Option Style**: `pills` (rounded pill-shaped options)
- **Option Columns**: `2` (two-column layout)
- **Sticky Navigation**: `true` (navigation sticks to top)

---

## 📋 Usage Examples

### CSS Variables (Pop Theme)
```css
.editmuse-concierge-root[data-em-brand="pop"] {
  --em-accent: #7C3AED;
  --em-accent2: #06B6D4;
  --em-surface: #FFFFFF;
  --em-text: #0B0B0F;
  --em-radius: 22px;
  --em-spacing: 16px;
}
```

### Inline Styles (React/JSX)
```jsx
// Banner
<div style={{
  padding: "1rem 1.5rem",
  background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
  border: "2px solid rgba(124, 58, 237, 0.5)",
  borderRadius: "12px",
  marginBottom: "1.5rem",
  color: "#FFFFFF",
  boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)"
}}>
  Content here
</div>

// Card
<div style={{
  padding: "1rem",
  backgroundColor: "#FFFFFF",
  border: "1px solid rgba(11, 11, 15, 0.12)",
  borderRadius: "12px",
  boxShadow: "0 2px 8px rgba(124, 58, 237, 0.1)"
}}>
  Card content
</div>

// Button
<button style={{
  padding: "0.625rem 1.25rem",
  background: "linear-gradient(135deg, #7C3AED, #06B6D4)",
  border: "none",
  borderRadius: "12px",
  color: "#FFFFFF",
  fontWeight: "500",
  boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)"
}}>
  Button Text
</button>
```

---

## 🎨 Color Psychology

### Purple (`#7C3AED`)
- **Meaning**: Creativity, innovation, luxury, tech-forward
- **Why**: Appeals to Gen-Z, modern, digital-native audience
- **Usage**: Primary actions, highlights, brand identity

### Cyan (`#06B6D4`)
- **Meaning**: Freshness, clarity, technology, energy
- **Why**: Complements purple, creates vibrant gradient
- **Usage**: Gradient endpoints, secondary accents

### Combination
- **Effect**: Creates energetic, modern, playful aesthetic
- **Target Audience**: Gen-Z, millennials, tech-savvy merchants
- **Brand Personality**: Innovative, approachable, fun

---

## 📐 Spacing & Layout

### Standard Spacing Scale
- **XS**: `8px`
- **S**: `12px`
- **M**: `16px` (base)
- **L**: `20px`
- **XL**: `24px`
- **XXL**: `32px`

### Padding Examples
- **Cards**: `1rem` (16px)
- **Banners**: `1rem 1.5rem` (16px vertical, 24px horizontal)
- **Sections**: `1.5rem` (24px)
- **Modals**: `2rem` (32px)

---

## 🎯 Where Pop Theme is Used

### Admin Pages
- ✅ **Billing Page** (`app.billing.tsx`)
  - Plan cards with purple borders
  - Gradient buttons
  - Status badges with pop colors
  - Success/error banners

- ✅ **Usage Page** (`app.usage.tsx`)
  - Metric cards with purple shadows
  - Upsell banner with gradient
  - Reporting sections with pop colors

- ✅ **Experience Creation** (when creating experiences)
  - Pop color theme applied to UI elements

### Theme Extension
- ✅ **Concierge Widget** (`editmuse-concierge.liquid`)
  - Modal styling with purple glow
  - Gradient buttons
  - Pop-themed option pills

- ✅ **Results Page** (`editmuse-results.liquid`)
  - Product cards with pop styling
  - Consistent color scheme

---

## 🔧 Implementation Notes

### CSS Custom Properties
The Pop theme uses CSS variables for easy theming:
```css
--em-accent: #7C3AED;
--em-accent2: #06B6D4;
--em-surface: #FFFFFF;
--em-text: #0B0B0F;
--em-radius: 18px;
--em-spacing: 16px;
```

### JavaScript Preset
```javascript
pop: {
  accent: "#7C3AED",
  accent2: "#06B6D4",
  useGradient: true,
  surface: "#FFFFFF",
  text: "#0B0B0F",
  mutedText: "rgba(11,11,15,0.62)",
  border: "rgba(11,11,15,0.14)",
  radius: 18,
  spacing: 16,
  fontScale: 1.04,
  shadow: "soft",
  buttonVariant: "solid",
  buttonRadius: 14,
  optionStyle: "pills",
  optionColumns: 2,
  stickyNav: true
}
```

---

## 📊 Comparison with Other Themes

| Feature | Pop | Minimal | Luxe |
|---------|-----|---------|------|
| **Accent** | `#7C3AED` (Purple) | `#111827` (Dark Gray) | `#B68C5A` (Gold) |
| **Accent 2** | `#06B6D4` (Cyan) | `#111827` (Dark Gray) | `#6B1D3B` (Burgundy) |
| **Gradient** | ✅ Yes | ❌ No | ❌ No |
| **Radius** | `18-22px` | `12-14px` | `18px` |
| **Shadow** | Soft (purple glow) | None | Medium |
| **Button** | Solid (gradient) | Outline | Solid |
| **Style** | Gen-Z, vibrant | Clean, minimal | Elegant, premium |

---

## ✅ Quick Reference

### Primary Gradient
```css
linear-gradient(135deg, #7C3AED, #06B6D4)
```

### Shadow Pattern
```css
box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
```

### Border Pattern
```css
border: 2px solid rgba(124, 58, 237, 0.3);
border-radius: 12px;
```

### Background Pattern (Subtle)
```css
background: linear-gradient(135deg, rgba(124, 58, 237, 0.1), rgba(6, 182, 212, 0.1));
```

---

## 🎯 Brand Guidelines

### Do's ✅
- Use gradients for primary elements (buttons, banners)
- Apply purple glow to shadows
- Use generous border radius (12-22px)
- Maintain high contrast (white surfaces, dark text)
- Use purple/cyan combination consistently

### Don'ts ❌
- Don't use flat colors when gradients are expected
- Don't use sharp corners (always round)
- Don't use low-contrast text
- Don't mix other accent colors (stick to purple/cyan)
- Don't use heavy shadows (keep them soft with purple tint)

---

## 📝 Summary

The **Pop Theme** is EditMuse's signature Gen-Z branding style featuring:
- **Purple (`#7C3AED`)** and **Cyan (`#06B6D4`)** gradient combinations
- **Rounded corners** (12-22px border radius)
- **Soft shadows** with purple glow
- **High contrast** white surfaces with dark text
- **Bold, energetic** aesthetic perfect for modern, tech-savvy merchants

This theme creates a vibrant, engaging user experience that stands out in the Shopify app ecosystem while maintaining professionalism and usability.

