// Initialize global variables
let debugFlag       = false;
let processingQueue = false;
let windowListBuffer = [];

chrome.windows.onCreated.addListener(function(window) {
	// Add new window ID to the queue to be processed
	if( window.state == "normal" ){
		windowListBuffer.push(window.id);
		debugPrint("Added: " + window.id);

		if( !processingQueue ){
			debugPrint("Processing Queue: STARTED");
			processingQueue = true;
			processQueue();
		}
	}
});

chrome.windows.onFocusChanged.addListener(function(windowID){
	// Start processing the window list if it is not already processing
	if( !processingQueue && windowListBuffer.length ){
		debugPrint("Processing Queue: STARTED");
		processingQueue = true;
		processQueue();
	}
});

async function processQueue(){
	// Process the windowListBuffer until it is empty

	while( windowListBuffer.length ){
		// Pull top entry
		const newWindowId = windowListBuffer.shift();
		debugPrint("Processing Queue: " + newWindowId);

		try {
			// Fetch new window
			const newWin = await chrome.windows.get(newWindowId);

			// Ask Chrome for the most recently focused window
			let parentWin = null;
			try {
				const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
				if( lastFocused && lastFocused.id !== newWindowId ){
					parentWin = lastFocused;
				}
			} catch(e) { /* fall through to horizontal-only positioning */ }

			// Get display info
			const displays = await chrome.system.display.getInfo();

			if( parentWin ){
				// Parent available — use its position and size
				await updateWindowPosition(newWin, parentWin, displays);
			} else {
				// No reference window — apply horizontal wrap-around only,
				// let Chrome handle vertical positioning
				await updateWindowPositionHorizontalOnly(newWin, displays);
			}

		} catch(error) {
			console.warn('[NewWindowToTheRight] Queue item failed:', error);
		}
	}

	// The queue is empty, stop processing
	processingQueue = false;
	debugPrint("Processing Queue: STOPPED");
}

async function updateWindowPositionHorizontalOnly(newWindow, displays){
	// Fallback when no reference window is available.
	// Applies horizontal wrap-around using the new window's own position,
	// but leaves vertical positioning to Chrome.

	const finalLeft = computeWindowPosition(newWindow, newWindow, displays);

	if( finalLeft !== newWindow.left ){
		await applyWindowUpdate(newWindow.id, { left: finalLeft });
	}
}

async function updateWindowPosition(newWindow, parentWindow, displays){
	// Computes the target position properties of newWindow and tries
	// multiple times to update the position to match
	// NOTE: Multiple attempts are sometimes required when desktop scaling is enabled and
	//       chrome is unable to match the pixels exactly on the first try (if at all)

	// Compute target positions
	const finalLeft  = computeWindowPosition(newWindow, parentWindow, displays);
	const goalVals = {
		left:   finalLeft,
		top:    parentWindow.top,
		height: parentWindow.height,
		width:  parentWindow.width
	};

	await applyWindowUpdate(newWindow.id, goalVals);
}

async function applyWindowUpdate(windowId, goalVals){
	// Tries multiple times to update window position to match goalVals.
	// Multiple attempts are sometimes required when desktop scaling is enabled and
	// Chrome is unable to match the pixels exactly on the first try (if at all).

	let updateVals = goalVals;
	for( let attempt = 0; attempt < 3; attempt++ ){
		try {
			const updatedWin = await chrome.windows.update(windowId, updateVals);

			// Check if position matches goal
			let totalDrift = 0;
			let nextVals = {};
			for( const key of Object.keys(goalVals) ){
				const d = goalVals[key] - updatedWin[key];
				totalDrift += Math.abs(d);
				nextVals[key] = updateVals[key] + d;
			}

			if( totalDrift === 0 ) break;

			updateVals = nextVals;
		} catch(error) {
			console.warn('[NewWindowToTheRight] Update attempt failed:', error);
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

chrome.runtime.onInstalled.addListener(async function(){
	// Enable the page action on all domains
	await chrome.declarativeContent.onPageChanged.removeRules();
	await chrome.declarativeContent.onPageChanged.addRules([{
		conditions: [new chrome.declarativeContent.PageStateMatcher({
		})
		],
		actions: [new chrome.declarativeContent.ShowAction()]
	}]);
});
