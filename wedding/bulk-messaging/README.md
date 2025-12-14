# Bulk WhatsApp Messaging Service

## Overview
This service allows you to send personalized WhatsApp messages to multiple guests with unique RSVP links. It includes both a web interface and a Node.js script for automated sending.

## Files
- `bulk-whatsapp-sender.html` - Web interface for sending bulk messages
- `bulk-whatsapp-sender.js` - Node.js script for automated sending via Twilio
- `package.json` - Node.js dependencies
- `phone-numbers.txt` - Sample phone numbers file
- `README.md` - This file

## Features
- **Web Interface**: Manual/semi-automated sending with multiple options
- **Node.js Script**: Automated sending via Twilio API
- **Personalized Links**: Each message includes unique phone parameter
- **Multiple Options**: Open all chats, copy messages, or download CSV

## Setup
1. Install Node.js dependencies: `npm install`
2. Configure Twilio credentials in `bulk-whatsapp-sender.js`
3. Prepare phone numbers list in `phone-numbers.txt`

## Deployment
### Web Interface
1. Upload `bulk-whatsapp-sender.html` to your web hosting
2. Update the message template and base URL as needed
3. Access via browser for manual sending

### Node.js Script
1. Ensure Node.js is installed
2. Run `npm install` to install dependencies
3. Configure Twilio credentials
4. Run: `node bulk-whatsapp-sender.js`

## Usage
- **Web Interface**: Upload to web hosting and access via browser
- **CLI Script**: Run locally with Node.js for automated sending

## Dependencies
- Twilio account for WhatsApp API
- Node.js for CLI script
- Web hosting for HTML interface 