// Initialize global variables
let debugFlag         = false;
let processingQueue   = false;
let lastFocusedWindowId = null;
let windowListBuffer  = [];

chrome.windows.onCreated.addListener(function(window) {
	// Add window ID and parent ID to the queue to be processed
	if( lastFocusedWindowId && window.state == "normal" ){
		windowListBuffer.push([window.id, lastFocusedWindowId]);
		debugPrint("Added: " + windowListBuffer[0]);
	}
});

chrome.windows.onFocusChanged.addListener(function(windowID){
	// Track the most recently focused window
	if( windowID > 0 ){
		lastFocusedWindowId = windowID;
		debugPrint("Focused: " + lastFocusedWindowId);
	}

	// Start processing the window list if it is not already processing
	if( !processingQueue && windowListBuffer.length ){
		debugPrint("Processing Queue: STARTED");
		processingQueue = true;
		processQueue();
	}
});

chrome.windows.onRemoved.addListener(function(windowID) {
	// Clear last focused window if it was closed
	if( windowID === lastFocusedWindowId ){
		lastFocusedWindowId = null;
	}
});

async function processQueue(){
	// Process the windowListBuffer until it is empty

	while( windowListBuffer.length ){
		// Pull top entry
		const queueData = windowListBuffer.shift();
		debugPrint("Processing Queue: " + queueData);

		try {
			// Fetch new window
			const newWin = await chrome.windows.get(queueData[0]);

			// Fetch parent window with error recovery
			let parentWin;
			try {
				parentWin = await chrome.windows.get(queueData[1]);
			} catch(error) {
				// Parent window was closed, fallback to most recent focused window
				if( lastFocusedWindowId ){
					parentWin = await chrome.windows.get(lastFocusedWindowId);
				} else {
					throw new Error('No parent window available');
				}
			}

			// Get display info
			const displays = await chrome.system.display.getInfo();

			// Update window position
			await updateWindowPosition([newWin, parentWin, displays]);

		} catch(error) {
			// Silently catch any errors
		}
	}

	// The queue is empty, stop processing
	processingQueue = false;
	debugPrint("Processing Queue: STOPPED");
}

async function updateWindowPosition(inputObjs){
	// Computes the target position properties of newWindow and tries
	// multiple times to update the position to match
	// NOTE: Multiple attempts are sometimes required when desktop scaling is enabled and
	//       chrome is unable to match the pixels exactly on the first try (if at all)

	// Parse inputObjs
	const newWindow    = inputObjs[0];
	const parentWindow = inputObjs[1];
	const displays     = inputObjs[2];

	// Compute target positions
	const finalLeft  = computeWindowPosition(newWindow, parentWindow, displays);
	const goalVals = {
		left:   finalLeft,
		top:    parentWindow.top,
		height: parentWindow.height,
		width:  parentWindow.width
	};

	// Update with retry logic (max 3 attempts)
	let updateVals = goalVals;
	for( let attempt = 0; attempt < 3; attempt++ ){
		try {
			const updatedWin = await chrome.windows.update(newWindow.id, updateVals);

			// Check if position matches goal
			const dLeft   = goalVals.left   - updatedWin.left;
			const dTop    = goalVals.top    - updatedWin.top;
			const dHeight = goalVals.height - updatedWin.height;
			const dWidth  = goalVals.width  - updatedWin.width;

			if( Math.abs(dLeft) + Math.abs(dTop) + Math.abs(dWidth) + Math.abs(dHeight) === 0 ){
				// Position matches perfectly, we're done
				break;
			}

			// Adjust for next attempt
			updateVals = {
				left:   updateVals.left   + dLeft,
				top:    updateVals.top    + dTop,
				height: updateVals.height + dHeight,
				width:  updateVals.width  + dWidth
			};
		} catch(error) {
			// Failed to update, stop trying
			break;
		}
	}
}

function computeWindowPosition(newWindow,parentWindow,displays) {
	// Computes the left pixel position for newWindow, ensuring that the window
	// is wrapped to avoid having any part of the window off screen

	// Initialize data
	let leftOffset    = 15;
	let windowLeft    = parentWindow.left;
	let finalLeft     = windowLeft + leftOffset;
	let windowTop     = parentWindow.top;
	let windowRight   = finalLeft + newWindow.width;
	let monitorLeft   = 0;
	let monitorTop    = 0;
	let monitorRight  = 0;
	let monitorBottom = 0;

	// Look through all monitors for source monitor
	for (let ii = 0; ii < displays.length; ii++) {
		monitorLeft   = displays[ii].workArea.left;
		monitorTop    = displays[ii].workArea.top;
		monitorRight  = displays[ii].workArea.left + displays[ii].workArea.width;
		monitorBottom = displays[ii].workArea.top  + displays[ii].workArea.height;
		if( windowLeft >= monitorLeft && windowLeft < monitorRight &&
		    windowTop  >= monitorTop  && windowTop  < monitorBottom ){
			// Found source monitor

			// Wrap window position if the right side extends beyond the monitor's area
			if( windowRight >= monitorRight ) {
				// Set to -7 to compensate for Chrome's invisible resize border
				// This makes the visible window edge flush with the screen edge
				finalLeft = displays[ii].workArea.left - 7;
			}
			break;
		};
	};

	return finalLeft;
};

function debugPrint(inputObj){
	// Wrapper to easily turn debug printing on/off
	if( debugFlag ){
		console.log(inputObj);
	};
};

function printBuffer(){
	// Shorcut function to print windowListBuffer to console
	let str = ["Queue:"];
	for( let ii = 0; ii < windowListBuffer.length; ii++ ){
		str[ii+1] = windowListBuffer[ii][0].toString() 
		+ " " + windowListBuffer[ii][1].toString() 
		+ " " + windowListBuffer[ii][2].toString();
	};
	debugPrint(str.join("\n"));
};

chrome.runtime.onInstalled.addListener(async function(){

	// Set the last focused window
	const lastWindow = await chrome.windows.getLastFocused();
	lastFocusedWindowId = lastWindow.id;
	debugPrint("Initial focused window: " + lastFocusedWindowId);

	// Enable the page action on all domains
	await chrome.declarativeContent.onPageChanged.removeRules();
	await chrome.declarativeContent.onPageChanged.addRules([{
		conditions: [new chrome.declarativeContent.PageStateMatcher({
			// pageUrl: {hostEquals: 'developer.chrome.com'},
		})
		],
		actions: [new chrome.declarativeContent.ShowAction()]
	}]);
 });
 
 