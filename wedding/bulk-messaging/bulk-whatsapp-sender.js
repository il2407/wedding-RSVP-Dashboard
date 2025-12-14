const twilio = require('twilio');
const fs = require('fs');
const readline = require('readline');

// Configuration
const config = {
    accountSid: 'YOUR_TWILIO_ACCOUNT_SID',
    authToken: 'YOUR_TWILIO_AUTH_TOKEN',
    fromNumber: 'whatsapp:+14155238886', // Your Twilio WhatsApp number
    baseUrl: 'https://ephemeral-douhua-685e37.netlify.app/',
    messageTemplate: `היי! 

אנחנו שמחים להזמין אותך לחתונה שלנו!

לחץ על הקישור הבא כדי לאשר את הגעתך:
{link}

נשמח לראותך!

איה ועידו`
};

// Initialize Twilio client
const client = twilio(config.accountSid, config.authToken);

// Function to send WhatsApp message
async function sendWhatsAppMessage(toPhone, message) {
    try {
        const result = await client.messages.create({
            body: message,
            from: config.fromNumber,
            to: `whatsapp:+972${toPhone.replace(/^0/, '')}` // Convert Israeli format
        });
        
        console.log(`✅ Message sent to ${toPhone}: ${result.sid}`);
        return { success: true, sid: result.sid };
    } catch (error) {
        console.error(`❌ Failed to send to ${toPhone}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Function to process bulk messages
async function sendBulkMessages(phoneNumbers, delayMs = 1000) {
    console.log(`🚀 Starting bulk send to ${phoneNumbers.length} numbers...`);
    
    const results = {
        successful: 0,
        failed: 0,
        errors: []
    };
    
    for (let i = 0; i < phoneNumbers.length; i++) {
        const phone = phoneNumbers[i].trim();
        
        if (!phone) continue;
        
        // Create personalized link
        const personalizedLink = `${config.baseUrl}?phone=${phone}`;
        const message = config.messageTemplate.replace(/{link}/g, personalizedLink);
        
        console.log(`📱 Sending to ${phone} (${i + 1}/${phoneNumbers.length})`);
        
        const result = await sendWhatsAppMessage(phone, message);
        
        if (result.success) {
            results.successful++;
        } else {
            results.failed++;
            results.errors.push({ phone, error: result.error });
        }
        
        // Delay between messages to avoid rate limits
        if (i < phoneNumbers.length - 1) {
            console.log(`⏳ Waiting ${delayMs}ms before next message...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    return results;
}

// Function to read phone numbers from file
function readPhoneNumbersFromFile(filename) {
    try {
        const content = fs.readFileSync(filename, 'utf8');
        return content.split('\n').filter(line => line.trim());
    } catch (error) {
        console.error(`❌ Error reading file: ${error.message}`);
        return [];
    }
}

// Function to save results to file
function saveResults(results, filename = 'bulk-send-results.json') {
    const timestamp = new Date().toISOString();
    const data = {
        timestamp,
        summary: {
            total: results.successful + results.failed,
            successful: results.successful,
            failed: results.failed
        },
        errors: results.errors
    };
    
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log(`📄 Results saved to ${filename}`);
}

// Main execution
async function main() {
    console.log('🎉 Bulk WhatsApp Sender - איה ועידו');
    console.log('=====================================\n');
    
    // Check if phone numbers file exists
    const phoneFile = 'phone-numbers.txt';
    if (!fs.existsSync(phoneFile)) {
        console.log(`📝 Creating ${phoneFile} with sample phone numbers...`);
        const samplePhones = [
            '0541234567',
            '0547654321',
            '0509876543'
        ];
        fs.writeFileSync(phoneFile, samplePhones.join('\n'));
        console.log(`✅ Created ${phoneFile}. Please edit it with your actual phone numbers.`);
        return;
    }
    
    // Read phone numbers
    const phoneNumbers = readPhoneNumbersFromFile(phoneFile);
    
    if (phoneNumbers.length === 0) {
        console.log('❌ No phone numbers found in phone-numbers.txt');
        return;
    }
    
    console.log(`📱 Found ${phoneNumbers.length} phone numbers`);
    console.log(`🔗 Base URL: ${config.baseUrl}`);
    console.log(`📝 Message template loaded\n`);
    
    // Confirm before sending
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
        rl.question(`Are you sure you want to send ${phoneNumbers.length} messages? (y/N): `, resolve);
    });
    
    rl.close();
    
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('❌ Cancelled by user');
        return;
    }
    
    // Send messages
    const results = await sendBulkMessages(phoneNumbers);
    
    // Display results
    console.log('\n📊 Results Summary:');
    console.log(`✅ Successful: ${results.successful}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`📈 Success Rate: ${((results.successful / (results.successful + results.failed)) * 100).toFixed(1)}%`);
    
    if (results.errors.length > 0) {
        console.log('\n❌ Errors:');
        results.errors.forEach(({ phone, error }) => {
            console.log(`  ${phone}: ${error}`);
        });
    }
    
    // Save results
    saveResults(results);
    
    console.log('\n🎉 Bulk send completed!');
}

// Run the script
if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    sendWhatsAppMessage,
    sendBulkMessages,
    readPhoneNumbersFromFile,
    saveResults
}; 