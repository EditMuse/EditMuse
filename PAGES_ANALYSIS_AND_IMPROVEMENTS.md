# EditMuse - 5 Navigation Pages Analysis & Improvement Recommendations

## Overview
The app has 5 main navigation pages, all PCD Level 0 compliant (no customer/order data access). This document analyzes each page and provides improvement recommendations.

---

## 1. Dashboard (`/app/dashboard`)

### Current Features ✅
- **Engagement Metrics**: Sessions, Results Generated, Product Clicks, Add to Cart, Checkout Started
- **Conversion Funnel**: Stops at "Add to Cart" (PCD compliant)
- **Top Queries**: Most popular search queries with session counts
- **Top Products**: Most recommended products with engagement metrics
- **Date Range Controls**: Last 7/30/90 days + Custom range with date pickers
- **CSV Export**: Full dashboard data export

### Current State
- ✅ PCD Level 0 compliant (no order/customer data)
- ✅ Well-structured with date filtering
- ✅ Good engagement metrics

### Improvement Recommendations 🚀

1. **Add Time Period Comparisons**
   - Show % change vs previous period (e.g., "↑ 15% vs last 30 days")
   - Add week-over-week, month-over-month comparisons
   - Visual indicators (green/red arrows) for trends

2. **Enhanced Top Products Table**
   - Add "View Product" link (opens Shopify product page)
   - Add product image thumbnails (if available via product handle)
   - Sort by different metrics (clicks, add to cart, recommendations)

3. **Query Insights**
   - Show query categories/trends
   - Highlight queries with high engagement but low results
   - Add "No Results" query tracking

4. **Performance Metrics**
   - Average results per session
   - Average time to results
   - Session completion rate (started → results generated)

5. **Visual Enhancements**
   - Add mini charts/sparklines for trends
   - Color-code metrics (green for good, yellow for warning)
   - Add loading states for better UX

---

## 2. Experiences (`/app/experiences`)

### Current Features ✅
- **Experience Management**: Create, edit, delete concierge experiences
- **Mode Selection**: Quiz, Chat, Hybrid modes
- **Collection/Tag Filtering**: Include/exclude collections and tags
- **Plan Limits**: Experience count limits based on subscription tier
- **Default Experience**: Automatic default experience handling

### Current State
- ✅ Good CRUD functionality
- ✅ Plan-based limits enforced
- ✅ Mode validation

### Improvement Recommendations 🚀

1. **Experience Analytics**
   - Add per-experience engagement metrics (sessions, results, clicks)
   - Show which experiences are most used
   - Add experience performance comparison

2. **Bulk Operations**
   - Duplicate experience feature
   - Bulk enable/disable
   - Export/import experiences (JSON)

3. **Advanced Configuration**
   - Result count per experience (override default)
   - Custom styling per experience
   - A/B testing per experience (if experiments are re-enabled)

4. **Preview Mode**
   - "Preview" button to test experience before publishing
   - Show how experience looks on storefront

5. **Usage Insights**
   - Show which collections/tags are most effective
   - Recommend collections based on product data
   - Highlight unused experiences

---

## 3. Usage (`/app/usage`)

### Current Features ✅
- **Credits Tracking**: Credits burned, usage percentage
- **Event Analytics**: Event counts by type (SESSION_STARTED, AI_RANKING_EXECUTED, etc.)
- **CTR Calculation**: Click-through rate (clicks/views)
- **Recent Events Table**: Last 500 events with metadata
- **Date Range Controls**: Same as Dashboard
- **CSV Export**: Usage data export
- **Upsell Banner**: Shows when credits usage >= 80%
- **Plan-Gated Reporting**: Mid/Advanced reporting sections

### Current State
- ✅ Comprehensive event tracking
- ✅ Good credit monitoring
- ✅ Plan-based feature gating

### Improvement Recommendations 🚀

1. **Credits Forecasting**
   - Predict when credits will run out based on current usage
   - Show daily/weekly/monthly credit burn rate
   - Add "Credits Remaining" countdown

2. **Event Filtering & Search**
   - Filter events by type, date range, experience
   - Search events by metadata (session ID, product handle)
   - Group similar events together

3. **Cost Analysis**
   - Show cost per event type
   - Identify most expensive operations
   - Recommend optimizations

4. **Usage Trends**
   - Chart showing credits burned over time
   - Peak usage times/hours
   - Usage patterns by day of week

5. **Event Details Modal**
   - Click event row to see full metadata
   - Pretty-print JSON metadata
   - Link to related session (if available)

6. **Remove Empty Reporting Sections**
   - The "Mid Reporting" and "Advanced Reporting" sections are empty placeholders
   - Either implement them or remove the UI elements

---

## 4. Billing (`/app/billing`)

### Current Features ✅
- **Plan Management**: View current plan, upgrade/downgrade
- **Usage Display**: Credits used, experience count
- **Add-ons**: Experience Pack, Advanced Reporting add-ons
- **Trial Status**: Trial period tracking
- **Shopify Integration**: Direct billing via Shopify

### Current State
- ✅ Full billing functionality
- ✅ Plan limits enforced
- ✅ Good Shopify integration

### Improvement Recommendations 🚀

1. **Usage Visualization**
   - Progress bars for credits (with color coding)
   - Visual representation of plan limits
   - "Upgrade needed" warnings when approaching limits

2. **Billing History**
   - Show past invoices/charges (if available from Shopify)
   - Payment method display
   - Billing cycle information

3. **Plan Comparison Table**
   - Side-by-side comparison of all plans
   - Highlight current plan
   - Show "Best Value" badges

4. **Usage Projections**
   - "At current rate, you'll use X credits this month"
   - Recommend plan based on usage patterns
   - Show savings if upgrading

5. **Add-on Management**
   - Better visibility of active add-ons
   - Clear pricing for add-ons
   - Easy enable/disable toggle

6. **Trial Countdown**
   - Visual countdown timer for trial users
   - Reminder notifications
   - Trial extension options (if applicable)

---

## 5. Diagnose (`/app/diagnose`)

### Current Features ✅
- **Error Logs**: Last 50 app errors with stack traces
- **Proxy Logs**: Last 50 proxy requests with status/duration
- **Debug Bundle Export**: Download JSON bundle of errors/logs

### Current State
- ✅ Good debugging tools
- ✅ Error tracking functional

### Improvement Recommendations 🚀

1. **Error Filtering & Search**
   - Filter by error type, route, date
   - Search error messages
   - Group similar errors together

2. **Error Analytics**
   - Error frequency chart
   - Most common errors
   - Error trends over time

3. **Proxy Log Analysis**
   - Filter by status code (4xx, 5xx)
   - Show slow requests (>1s)
   - Request pattern analysis

4. **Real-time Monitoring**
   - Auto-refresh logs (optional)
   - Live error notifications
   - Error rate alerts

5. **Enhanced Debug Bundle**
   - Include more context (shop info, recent sessions)
   - Add timestamps and version info
   - Compress bundle for easier sharing

6. **Error Resolution Help**
   - Link to documentation for common errors
   - Suggested fixes for known issues
   - Contact support button with pre-filled error info

7. **Performance Metrics**
   - Average response times
   - P95/P99 latency
   - Request volume over time

---

## Cross-Page Improvements 🎯

### 1. **Consistent Date Range Controls**
   - ✅ Already implemented on Dashboard and Usage
   - Consider adding to Experiences (filter by creation date)
   - Add to Billing (usage history by date)

### 2. **Breadcrumb Navigation**
   - Add breadcrumbs to all pages for better navigation
   - Show current page context

### 3. **Search Functionality**
   - Global search across experiences, queries, products
   - Quick navigation to any page

### 4. **Keyboard Shortcuts**
   - `Cmd/Ctrl + K` for quick search
   - `Cmd/Ctrl + D` for dashboard
   - `Cmd/Ctrl + U` for usage

### 5. **Export Consistency**
   - Standardize CSV export format across pages
   - Add JSON export option
   - Scheduled exports (email reports)

### 6. **Mobile Responsiveness**
   - Ensure all pages work well on mobile
   - Collapsible sections for small screens
   - Touch-friendly controls

### 7. **Loading States**
   - Skeleton loaders for better perceived performance
   - Progress indicators for long operations
   - Optimistic UI updates

### 8. **Error Handling**
   - User-friendly error messages
   - Retry mechanisms
   - Graceful degradation

---

## PCD Level 0 Compliance Checklist ✅

All pages are currently PCD Level 0 compliant:
- ✅ No order data access
- ✅ No customer data access
- ✅ No checkout data access
- ✅ No cart data access
- ✅ Only engagement analytics (sessions, clicks, events)
- ✅ Anonymous session tracking only

**Note**: `CHECKOUT_STARTED` events are tracked but only as engagement metrics (no order/customer linking). The `AttributionAttempt` model exists but is not actively used for order attribution (PCD compliant).

---

## Priority Recommendations 🎯

### High Priority
1. **Dashboard**: Add time period comparisons and trend indicators
2. **Usage**: Remove empty "Mid Reporting" and "Advanced Reporting" sections
3. **Experiences**: Add per-experience analytics
4. **Diagnose**: Add error filtering and search

### Medium Priority
1. **Dashboard**: Add product images and links
2. **Usage**: Add credits forecasting
3. **Billing**: Add usage visualization and projections
4. **All Pages**: Improve mobile responsiveness

### Low Priority
1. **All Pages**: Add keyboard shortcuts
2. **All Pages**: Add breadcrumb navigation
3. **Diagnose**: Add real-time monitoring
4. **Experiences**: Add preview mode

---

## Implementation Notes

- All improvements should maintain PCD Level 0 compliance
- Focus on engagement metrics only (no order/customer data)
- Ensure all new features respect plan limits
- Test thoroughly before deployment
- Consider performance impact of new features

