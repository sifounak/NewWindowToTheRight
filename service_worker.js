// Initialize global variables
let debugFlag         = false;
let processingQueue   = false;
let lastFocusedWindowId = null;
let windowListBuffer  = [];
const CASCADE_OFFSET  = 26;   // Approximate OS cascade delta (pixels, 100% DPI)

chrome.windows.onCreated.addListener(function(window) {
	// Add window ID and parent ID to the queue to be processed
	// parentId is null when the service worker just woke from dormancy
	let parentId = lastFocusedWindowId;

	if( window.state == "normal" ){
		windowListBuffer.push([window.id, parentId]);
		debugPrint("Added: " + windowListBuffer[0]);

		if( !processingQueue ){
			debugPrint("Processing Queue: STARTED");
			processingQueue = true;
			processQueue();
		}
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
			let parentWin = null;
			if( queueData[1] ){
				try {
					parentWin = await chrome.windows.get(queueData[1]);
				} catch(error) {
					// Parent window was closed, try most recent focused window
					if( lastFocusedWindowId ){
						try {
							parentWin = await chrome.windows.get(lastFocusedWindowId);
						} catch(e) { /* fall through to estimated positioning */ }
					}
				}
			}

			// Get display info
			const displays = await chrome.system.display.getInfo();

			if( parentWin ){
				// Parent available — use its position and size
				await updateWindowPosition(newWin, parentWin, displays);
			} else {
				// Parent unavailable — estimate position from the new window itself
				await updateWindowPositionEstimated(newWin, displays);
			}

		} catch(error) {
			console.warn('[NewWindowToTheRight] Queue item failed:', error);
		}
	}

	// The queue is empty, stop processing
	processingQueue = false;
	debugPrint("Processing Queue: STOPPED");
}

async function updateWindowPositionEstimated(newWindow, displays){
	// Fallback when parent window is unavailable (e.g. service worker cold-start).
	// Estimates the parent position from the new window's Chrome-assigned position
	// by reversing the OS cascade offset, then applies horizontal overflow check.

	// Chrome's windows API uses DIPs (device-independent pixels), but the OS
	// cascade offset is in physical pixels. Scale accordingly.
	const scaleFactor = getScaleFactorForWindow(newWindow, displays);
	const cascadeDIPs = Math.round(CASCADE_OFFSET / scaleFactor);

	const estimatedParentLeft = newWindow.left - cascadeDIPs;
	const estimatedParentTop  = newWindow.top  - cascadeDIPs;

	// Build a synthetic parent for the horizontal overflow check
	const syntheticParent = { left: estimatedParentLeft, top: estimatedParentTop };
	const finalLeft = computeWindowPosition(newWindow, syntheticParent, displays);

	const goalVals = {
		left: finalLeft,
		top:  estimatedParentTop
	};

	await applyWindowUpdate(newWindow.id, goalVals);
}

function getScaleFactorForWindow(win, displays){
	// Find which display contains the window and return its scale factor.
	for( const display of displays ){
		const area = display.workArea;
		if( win.left >= area.left && win.left < area.left + area.width &&
		    win.top  >= area.top  && win.top  < area.top + area.height ){
			return display.deviceScaleFactor || 1;
		}
	}
	// Default to first display's scale factor, or 1
	return (displays.length && displays[0].deviceScaleFactor) || 1;
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

chrome.runtime.onStartup.addListener(async function(){
	// Chrome just launched — seed lastFocusedWindowId before the user can Ctrl+N
	try {
		const lastWindow = await chrome.windows.getLastFocused();
		if( lastWindow ) lastFocusedWindowId = lastWindow.id;
		debugPrint("Startup focused window: " + lastFocusedWindowId);
	} catch(error) {
		console.warn('[NewWindowToTheRight] onStartup init failed:', error);
	}
});

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
 
 