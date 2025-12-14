# Wedding RSVP Form

## Overview
This is the main wedding RSVP form that guests use to respond to the wedding invitation. It includes personalized greetings, photo popups, and a professional wedding theme design.

## Files
- `index.html` - Main RSVP form with personalized greetings and photo popups
- `sticker.png` - Decorative sticker for "איה"
- `stickerido.png` - Decorative sticker for "ועידו"
- `happy.JPG` - Photo shown when guests confirm attendance
- `sad.JPG` - Photo shown when guests decline

## Features
- **Personalized Greetings**: Shows guest name based on phone number URL parameter
- **Photo Popups**: Displays different photos based on guest count
- **Professional Design**: Orange wedding theme with animations
- **Mobile Responsive**: Optimized for phone use
- **Form Validation**: Ensures proper data submission

## Deployment
1. Upload all files to your web hosting service
2. Ensure the `INVITED_API` URL in `index.html` points to your guest list
3. Update the form submission URL to your data collection endpoint
4. Test with different phone number parameters

## Usage
Guests access the form via URL with phone parameter:
```
https://your-domain.com/?phone=0547654579
```

## Dependencies
- External API for guest list (SheetDB.io or similar)
- External API for form submission (Google Sheets, Airtable, etc.)
