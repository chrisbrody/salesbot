const fs = require('fs');
const util = require('util');

const logFile = 'output.log';

// Create a write stream to append logs to the log file
const logFileStream = fs.createWriteStream(logFile, { flags: 'a' });

// Function to clear the log file
function clearLogFile() {
  fs.truncateSync(logFile, 0); // Truncate the file to remove its content
}

// Override console.log to log to both console and file using the custom log function
console.log = function (...args) {
  const message = args.map(arg => util.inspect(arg)).join(' '); // Combine and format arguments

  // Log to console immediately
  process.stdout.write(message + '\n');

  // Log to the file immediately
  logFileStream.write(`${message}\n`);
};

module.exports = {
  clearLogFile, // Export the function to clear the log file
};