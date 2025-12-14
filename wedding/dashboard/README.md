# Wedding RSVP Dashboard

## Overview
This dashboard displays RSVP responses and invited guest lists in a professional, animated interface. It shows guest names, phone numbers, and RSVP status with a beautiful orange wedding theme.

## Files
- `dashboard.html` - Main dashboard with RSVP and invited guest tables
- `README.md` - This file

## Features
- **RSVP Tracking**: Displays all RSVP responses with guest names
- **Guest List**: Shows complete invited guest list
- **Professional Design**: Orange wedding theme with animations
- **Responsive Tables**: Mobile-friendly data display
- **Real-time Data**: Fetches data from external APIs

## Deployment
1. Upload `dashboard.html` to your web hosting service
2. Ensure the API URLs in the file point to your data sources:
   - `RSVP_API` - for RSVP responses
   - `INVITED_API` - for invited guest list
3. Test the dashboard to ensure data loads correctly

## API Requirements
- **RSVP API**: Should return data with phone numbers and guest counts
- **Invited API**: Should return data with phone numbers and guest names
- Both APIs should be accessible via CORS

## Usage
Access the dashboard via browser to view:
- Total RSVP responses
- Guest names and phone numbers
- RSVP status and guest counts
- Complete invited guest list

## Dependencies
- External APIs for RSVP and guest list data
- Web hosting service
