// Initialize global variables
var debugFlag        = false;
var processingQueue  = false;
var availableWindows = [];
var windowListBuffer = [];

chrome.windows.onCreated.addListener(function(window) {
	// Add window ID and parent ID to the queue to be processed
	if( availableWindows.length > 0 && window.state == "normal" ){
		windowListBuffer.push([window.id,availableWindows[0]]);
		debugPrint("Added: " + windowListBuffer[0]);
	};
});

chrome.windows.onFocusChanged.addListener(function(windowID){
	// Move the focused window ID to the top of the availableWindows list
	// NOTE: This will also add the ID if it doesn't already exist
	if( windowID > 0 ){
		moveWindowToTheTop(windowID);
		debugPrint("Focused: " + availableWindows[0]);
		debugPrint(availableWindows);
	};
	
	// Start processing the window list if it is not already processing
	if( !processingQueue && windowListBuffer.length ){
		debugPrint("Processing Queue: STARTED");
		processingQueue = true;
		processTopOfQueue();
	};
});

chrome.windows.onRemoved.addListener(function(windowID) {
	// Remove window from the availableWindows list
	removeAvailableWindow(windowID);
});

function getAvailableWindowIndex(winID){
	// Similar to "indexOf" but more consistent/synchronous behavior
	for( let ii = 0; ii < availableWindows.length; ii++ ){
		if( winID == availableWindows[ii] ){
			return ii;
		}
	};
	return -1;
};

function moveWindowToTheTop(winID){
	// Move the winID to the top of the availableWindows list or add it if it doesn't exist
	var winIndex = getAvailableWindowIndex(winID);
	if( winIndex >= 0 ){
		availableWindows.splice(winIndex,1);
	};
	availableWindows.unshift(winID);
};

function removeAvailableWindow(winID){
	// Remove winID from the availableWindows list
	var winIndex = getAvailableWindowIndex(winID);
	if( winIndex >= 0 ){
		availableWindows.splice(winIndex,1);
		debugPrint("Destroyed: " + winID + ";");
		debugPrint(availableWindows);
	};
};

function processTopOfQueue(){
	// Process the windowListBuffer until it is empty
	
	// Process list if an entry exists in  windowListBuffer
	if( windowListBuffer.length ){
		// Pull top entry
		var queueData = windowListBuffer.shift();
		debugPrint("Processing Queue: " + queueData);
		
		// Kick off update process
		promisify(chrome.windows.get,queueData[0])
		.then(newWin => promisify(chrome.windows.get,queueData[1],newWin))
		.catch(newWin => recoverFromParentError(newWin))
		.then(newWinAndParent => promisify(chrome.system.display.getInfo,undefined,newWinAndParent))
		.then(inputObjs => updateWindowPosition(inputObjs))
		.catch(results => setTimeout(Function.prototype,0))
		.then(results => processTopOfQueue());
		
	} else {
		// The queue is empty, so stop processing
		processingQueue = false;
		debugPrint("Processing Queue: STOPPED");
	};
};

function recoverFromParentError(newWin){
	// If an error is caught during the parent fetch, try to recover using
	// the top-most window
	if( availableWindows.length ){
		return promisify(chrome.windows.get,availableWindows[0],newWin)
	};
	// No parent window is available, so just reject again
	return new Promise( function(resolve,reject){ reject() });
};

function updateWindowPosition(inputObjs){
	// Computes the target position properties of newWindow and tries 
	// 3 times to update the position to match
	// NOTE: Multiple attempts are sometimes required when desktop scaling is enabled and 
	//       chrome is unable to match the pixels exactly on the first try (if at all)
	
	// Parse inputObjs
	var newWindow    = inputObjs[0];
	var parentWindow = inputObjs[1];
	var displays     = inputObjs[2];
	
	// Compute target positions
	let finalLeft  = computeWindowPosition(newWindow,parentWindow,displays);
	let goalVals = { 
		left:   finalLeft          ,
		top:    parentWindow.top   ,
		height: parentWindow.height, 
		width:  parentWindow.width };
	
	// Kick off update procedure
	promisify(chrome.windows.update,[newWindow.id,goalVals])
	.then(updatedWin => applyAnotherUpdateIfNeeded([updatedWin,goalVals]))
	.catch(results => applyAnotherUpdateIfNeeded(results))
	.catch(results => setTimeout(Function.prototype,0));
	
};

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
				finalLeft = displays[ii].workArea.left;
			};
			break;
		};
	};

	// Return value
	return finalLeft;
};

function applyAnotherUpdateIfNeeded(data) {
	// If the currWindow's position doesn't match the goalVals, 
	// compute an adjustment and try again
	
	// Parse input array
	var currWindow    = data[0];
	var goalVals      = data[1];
	var oldUpdateVals = data[1];
	if( data.length > 2 ){
		oldUpdateVals = data[2];
	};
	
	// Return new Promise to try again
	return new Promise( function (resolve,reject) {
		
		// Compute the difference between what we asked for and what we got
		let dLeft   = goalVals.left   - currWindow.left;
		let dTop    = goalVals.top    - currWindow.top;
		let dHeight = goalVals.height - currWindow.height;
		let dWidth  = goalVals.width  - currWindow.width;
		
		if( Math.abs(dLeft) + Math.abs(dTop) + Math.abs(dWidth) + Math.abs(dHeight) > 0 ){
			// Compute new target position values
			let newUpdateVals = {
				left:   oldUpdateVals.left   + dLeft  ,
				top:    oldUpdateVals.top    + dTop   ,
				height: oldUpdateVals.height + dHeight,
				width:  oldUpdateVals.width  + dWidth };
			chrome.windows.update(currWindow.id,newUpdateVals,function(updatedWindow){reject([updatedWindow,goalVals,newUpdateVals])});
			return;
		} else {
			resolve();
		};
	});
	
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

function promisify(fun,arg,passthroughs){
	// This is a wrapper function to make a callback function Promise-compatible.
	
	// Input arguments:
	// fun			-	The function to be called (synchronous or asynchronous)
	// arg			-	An array of arguments to be passed into "fun"
	//					If a non-array is passed in, arg is automatically converted to an array
	// passthroughs	-	Data to be passed through as an output
	
	// What does the equivalent function look like:
	// 1) arg == undefined and passthroughs == undefined:
	// 		result = fun(result => resolve(result));
	// 2) arg = 5 and passthrough = undefined:
	//		result = fun(...[5],result => resolve(result));
	// 3) arg = [5,10] and passthrough = undefined:
	//		result = fun(...[5,10],result => resolve(result));
	// 4) arg = 5 and passthrough = [10,15]:
	//		[10,15,result] = fun(...[5],result => resolve(passthroughs.push(result)));
	//		NOTES:	-- If passthroughs is not an array, it will be converted to an array
	//				-- If result is a 1-element array, the data will be extracted from the array
	// 5) result == undefined:
	//		passthroughs = function(...[arg],result => reject(passthroughs));
	
	
	// Convert arg to an array if is not already
	if( arg !== undefined && arg.constructor !== Array ){
		arg = [arg];
	};
	
	return new Promise( function (resolve,reject) {
		// Create default passthrough of result
		var returnFun = function(result){
			resolve(result);
		};
		
		// Create more complicated passthrough function if passthroughs are supplied
		if( passthroughs != undefined ){
			returnFun = function(result){
				
				// Reject if the result is undefined
				if( result == undefined ){
					reject(passthroughs);
				};
				
				// Extract result from array if it is a 1-element array
				if( result.constructor === Array && result.length == 1 ){
					result = result[0];
				};
				
				// Convert passthroughs to an array if it is not already
				if( passthroughs.constructor !== Array ){
					passthroughs = [passthroughs];
				};
				
				// Append result to passthroughs are resolve
				passthroughs[passthroughs.length] = result;
				resolve(passthroughs);
			};
		};
		
		// Call the function
		if( arg != undefined ){
			fun(...arg,result => returnFun(result));
		} else {
			fun(result => returnFun(result));
		};
	});
};

chrome.runtime.onInstalled.addListener(function(){
	
	// Create the initial availableWindows list
	chrome.windows.getAll(function(allWindows){
		for( let ii = 0; ii < allWindows.length; ii++ ){
			availableWindows[ii] = allWindows[ii].id;
		};
		debugPrint(availableWindows);
	});
	
	chrome.windows.getLastFocused(function(lastWindow){
		moveWindowToTheTop(lastWindow.id);
	});
	
	// Enable the page action page on all domains
	chrome.declarativeContent.onPageChanged.removeRules(undefined, function() {
      chrome.declarativeContent.onPageChanged.addRules([{
        conditions: [new chrome.declarativeContent.PageStateMatcher({
          // pageUrl: {hostEquals: 'developer.chrome.com'},
        })
        ],
            actions: [new chrome.declarativeContent.ShowPageAction()]
      }]);
    });
 });
 
 