/**
 * Pointer to the projected slide show if there is one
 */
var presentationConnection = null;

/**
 * @fileOverview Code needed by the HTML Slidy receiver application to
 * listen to messages from the presentation sender and react accordingly,
 * dispatching received commands to the controlled slide show.
 */
window.onload = function () {
  /**
   * Pointer to the "w3c_slidy" object in controlled slideshow
   */
  var controlledSlidy = null;

  /**
   * The controlled slideshow is displayed in a child iframe
   */
  var iframe = document.querySelector('iframe');
  iframe.onload = function () {
    controlledSlidy = iframe.contentWindow.w3c_slidy;
  };

  /**
   * React to the establishment of a new connection
   */
  navigator.w3cPresentation.receiver.getConnection().then(function (connection) {
    presentationConnection = connection;
    connection.onmessage = function (event) {
      var params = null;
      var message = event.data;
      if (!message || !message.cmd) {
        return;
      }
      if (message.cmd === 'open') {
        console.info('open slideshow at "' + message.url + '"');
        iframe.src = message.url;
      }
      else if (!controlledSlidy) {
        return;
      }
      else {
        // Send command to controlled Slidy instance
        params = message.params || [];
        controlledSlidy[message.cmd].apply(controlledSlidy, params);
      }
    };
  });
};