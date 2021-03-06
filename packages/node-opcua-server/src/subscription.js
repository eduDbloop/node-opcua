"use strict";
/**
 * @module opcua.server
 */


var Dequeue = require("dequeue");

var subscription_service = require("node-opcua-service-subscription");
var DataChangeNotification = subscription_service.DataChangeNotification;
var EventNotificationList = subscription_service.EventNotificationList;
var NotificationMessage = subscription_service.NotificationMessage;
var StatusChangeNotification = subscription_service.StatusChangeNotification;
var MonitoringMode = subscription_service.MonitoringMode;
var NodeId = require("node-opcua-nodeid").NodeId;
var StatusCodes = require("node-opcua-status-code").StatusCodes;
var Enum = require("node-opcua-enum");
var assert = require("node-opcua-assert");
var _ = require("underscore");

var AttributeIds = require("node-opcua-data-model").AttributeIds;

var SequenceNumberGenerator = require("node-opcua-secure-channel").SequenceNumberGenerator;

var EventEmitter = require("events").EventEmitter;
var util = require("util");

var SessionContext = require("node-opcua-address-space").SessionContext;

var EventFilter = require("node-opcua-service-filter").EventFilter;
var DataChangeFilter = require("node-opcua-service-subscription").DataChangeFilter;
var AggregateFilter = require("node-opcua-service-subscription").AggregateFilter;

var UAVariable = require("node-opcua-address-space").UAVariable;
var validateFilter = require("./validate_filter").validateFilter;
var is_valid_dataEncoding = require("node-opcua-data-model").is_valid_dataEncoding;


var debugLog = require("node-opcua-debug").make_debugLog(__filename);
var doDebug = require("node-opcua-debug").checkDebugFlag(__filename);


var SubscriptionState = new Enum([
    "CLOSED",   // The Subscription has not yet been created or has terminated.
    "CREATING", // The Subscription is being created
    "NORMAL",   // The Subscription is cyclically checking for Notifications from its MonitoredItems.
                // The keep-alive counter is not used in this state.
    "LATE",     // The publishing timer has expired and there are Notifications available or a keep-alive Message is
                // ready to be sent, but there are no Publish requests queued. When in this state, the next Publish
                // request is processed when it is received. The keep-alive counter is not used in this state.
    "KEEPALIVE",// The Subscription is cyclically checking for Notification
                // alive counter to count down to 0 from its maximum.
    "TERMINATED"
]);
exports.SubscriptionState = SubscriptionState;


var SubscriptionDiagnostics = require("node-opcua-common").SubscriptionDiagnostics;


function _adjust_publishing_interval(publishingInterval) {
    publishingInterval = publishingInterval || Subscription.defaultPublishingInterval;
    publishingInterval = Math.max(publishingInterval, Subscription.minimumPublishingInterval);
    publishingInterval = Math.min(publishingInterval, Subscription.maximumPublishingInterval);
    return publishingInterval;
}

var minimumMaxKeepAliveCount = 2;
var maximumMaxKeepAliveCount = 12000;

function _adjust_maxKeepAliveCount(maxKeepAliveCount/*,publishingInterval*/) {
    maxKeepAliveCount = maxKeepAliveCount || minimumMaxKeepAliveCount;
    maxKeepAliveCount = Math.max(maxKeepAliveCount, minimumMaxKeepAliveCount);
    maxKeepAliveCount = Math.min(maxKeepAliveCount, maximumMaxKeepAliveCount);
    return maxKeepAliveCount;
}

function _adjust_lifeTimeCount(lifeTimeCount, maxKeepAliveCount, publishingInterval) {
    lifeTimeCount = lifeTimeCount || 1;

    // let's make sure that lifeTimeCount is at least three time maxKeepAliveCount
    // Note : the specs say ( part 3  - CreateSubscriptionParameter )
    //        "The lifetime count shall be a minimum of three times the keep keep-alive count."
    lifeTimeCount = Math.max(lifeTimeCount, maxKeepAliveCount * 3);

    var minTicks = Math.ceil(5 * 1000 / (publishingInterval)); // we want 5 seconds min

    lifeTimeCount = Math.max(minTicks, lifeTimeCount);
    return lifeTimeCount;
}

function _adjust_publishinEnable(publishingEnabled) {
    return (publishingEnabled === null || publishingEnabled === undefined) ? true : !!publishingEnabled;
}

function _adjust_maxNotificationsPerPublish(maxNotificationsPerPublish) {
    maxNotificationsPerPublish += 0;
    assert(_.isNumber(maxNotificationsPerPublish));
    return (maxNotificationsPerPublish >= 0) ? maxNotificationsPerPublish : 0;
}

// verify that the injected publishEngine provides the expected services
// regarding the Subscription requirements...
function _assert_valid_publish_engine(publishEngine) {
    assert(_.isObject(publishEngine));
    assert(_.isNumber(publishEngine.pendingPublishRequestCount));
    assert(_.isFunction(publishEngine.send_notification_message));
    assert(_.isFunction(publishEngine.send_keep_alive_response));
    assert(_.isFunction(publishEngine.on_close_subscription));
}


function createSubscriptionDiagnostics(self) {

    assert(self instanceof Subscription);

    self.subscriptionDiagnostics = new SubscriptionDiagnostics({});

    self.subscriptionDiagnostics.$subscription = self;
    // "sessionId"
    self.subscriptionDiagnostics.__defineGetter__("sessionId", function () {
      return this.$subscription.getSessionId();
    });
    self.subscriptionDiagnostics.__defineGetter__("subscriptionId", function () {
        return this.$subscription.id;
    });
    self.subscriptionDiagnostics.__defineGetter__("priority", function () {
        return this.$subscription.priority;
    });
    self.subscriptionDiagnostics.__defineGetter__("publishingInterval", function () {
        return this.$subscription.publishingInterval;
    });
    self.subscriptionDiagnostics.__defineGetter__("maxLifetimeCount", function () {
        return this.$subscription.lifeTimeCount;
    });
    self.subscriptionDiagnostics.__defineGetter__("maxKeepAliveCount", function () {
        return this.$subscription.maxKeepAliveCount;
    });
    self.subscriptionDiagnostics.__defineGetter__("maxNotificationsPerPublish", function () {
        return this.$subscription.maxNotificationsPerPublish;
    });
    self.subscriptionDiagnostics.__defineGetter__("publishingEnabled", function () {
        return this.$subscription.publishingEnabled;
    });
    self.subscriptionDiagnostics.__defineGetter__("monitoredItemCount", function () {
        return this.$subscription.monitoredItemCount;
    });
    self.subscriptionDiagnostics.__defineGetter__("nextSequenceNumber", function () {
        return this.$subscription._get_future_sequence_number();
    });
    self.subscriptionDiagnostics.__defineGetter__("disabledMonitoredItemCount", function () {
        return this.$subscription.disabledMonitoredItemCount;
    });

    /* those member of self.subscriptionDiagnostics are handled directly

     modifyCount
     enableCount,
     disableCount,
     republishRequestCount,
     notificationsCount,
     publishRequestCount,
     dataChangeNotificationsCount,
     eventNotificationsCount,
    */

    /*
     those members are not updated yet in the code :
     "republishMessageRequestCount",
     "republishMessageCount",
     "transferRequestCount",
     "transferredToAltClientCount",
     "transferredToSameClientCount",
     "latePublishRequestCount",
     "currentKeepAliveCount",
     "currentLifetimeCount",
     "unacknowledgedMessageCount",
     "discardedMessageCount",
     "monitoringQueueOverflowCount",
     "eventQueueOverFlowCount"
     */
    // add object in Variable SubscriptionDiagnosticArray (i=2290) ( Array of SubscriptionDiagnostics)
    // add properties in Variable to reflect
}

/**
 * The Subscription class used in the OPCUA server side.
 * @class Subscription
 * @param {Object} options
 * @param options.id {Integer} - a unique identifier
 * @param options.publishingInterval {Integer} - [optional](default:1000) the publishing interval.
 * @param options.maxKeepAliveCount  {Integer} - [optional](default:10) the max KeepAlive Count.
 * @param options.lifeTimeCount      {Integer} - [optional](default:10) the max Life Time Count
 * @param options.publishingEnabled  {Boolean} - [optional](default:true)
 * @param options.sessionId          {NodeId}  - [optional]
 * @param options.maxNotificationsPerPublish {Integer} - [optional](default:0)
 * @param options.priority {Byte}
 * @constructor
 */
function Subscription(options) {

    options = options || {};

    EventEmitter.apply(this, arguments);


    var subscription = this;

    Subscription.registry.register(subscription);

    subscription._sessionId = options.sessionId|| NodeId.NullNodeId;
    assert(subscription._sessionId instanceof NodeId,"expecting a sessionId NodeId");

    subscription.publishEngine = options.publishEngine;
    _assert_valid_publish_engine(subscription.publishEngine);

    subscription.id = options.id || "<invalid_id>";

    subscription.priority = options.priority || 0;


    /**
     * the Subscription publishing interval
     * @property  publishingInterval
     * @type {number}
     * @default 1000
     */
    subscription.publishingInterval = _adjust_publishing_interval(options.publishingInterval);

    /**
     * The keep alive count defines how many times the publish interval need to
     * expires without having notifications available before the server send an
     * empty message.
     * OPCUA Spec says: a value of 0 is invalid.
     * @property  maxKeepAliveCount
     * @type {number}
     * @default 10
     *
     */
    subscription.maxKeepAliveCount = _adjust_maxKeepAliveCount(options.maxKeepAliveCount, subscription.publishingInterval);

    subscription.resetKeepAliveCounter();

    /**
     * The life time count defines how many times the publish interval expires without
     * having a connection to the client to deliver data.
     * If the life time count reaches maxKeepAliveCount, the subscription will
     * automatically terminate.
     * OPCUA Spec: The life-time count shall be a minimum of three times the keep keep-alive count.
     *
     * Note: this has to be interpreted as without having a PublishRequest available
     * @property  lifeTimeCount
     * @type {Number}
     * @default 1
     */
    subscription.lifeTimeCount = _adjust_lifeTimeCount(options.lifeTimeCount, subscription.maxKeepAliveCount, subscription.publishingInterval);


    /**
     * The maximum number of notifications that the Client wishes to receive in a
     * single Publish response. A value of zero indicates that there is no limit.
     * The number of notifications per Publish is the sum of monitoredItems in the
     * DataChangeNotification and events in the EventNotificationList.
     *
     * @property maxNotificationsPerPublish
     * @type {Number}
     * #default 0
     */
    subscription.maxNotificationsPerPublish = _adjust_maxNotificationsPerPublish(options.maxNotificationsPerPublish);

    subscription._life_time_counter = 0;
    subscription.resetLifeTimeCounter();

    // notification message that are ready to be sent to the client
    subscription._pending_notifications = new Dequeue();

    subscription._sent_notifications = [];

    subscription._sequence_number_generator = new SequenceNumberGenerator();

    // initial state of the subscription
    subscription.state = SubscriptionState.CREATING;

    subscription.publishIntervalCount = 0;

    subscription.monitoredItems = {}; // monitored item map

    /**
     *  number of monitored Item
     *  @property monitoredItemIdCounter
     *  @type {Number}
     */
    subscription.monitoredItemIdCounter = 0;

    subscription.publishingEnabled = _adjust_publishinEnable(options.publishingEnabled);

    subscription.subscriptionDiagnostics = null;
    createSubscriptionDiagnostics(subscription);

    // A boolean value that is set to TRUE to mean that either a NotificationMessage or a keep-alive Message has been
    // sent on the Subscription. It is a flag that is used to ensure that either a NotificationMessage or a keep-alive
    // Message is sent out the first time the publishing timer expires.
    subscription.messageSent = false;

    subscription._unacknowledgedMessageCount = 0;

    subscription.timerId = null;
    subscription._start_timer();

}

util.inherits(Subscription, EventEmitter);


Subscription.minimumPublishingInterval = 50;  // fastest possible
Subscription.defaultPublishingInterval = 1000; // one second
Subscription.maximumPublishingInterval = 1000 * 60 * 60 * 24 * 15; // 15 days
assert(Subscription.maximumPublishingInterval < 2147483647, "maximumPublishingInterval cannot exceed (2**31-1) ms ");


var ObjectRegistry = require("node-opcua-object-registry").ObjectRegistry;
Subscription.registry = new ObjectRegistry();

Subscription.prototype.getSessionId = function () {
    var subscription = this;
    return subscription._sessionId;
};

Subscription.prototype.toString = function () {

    var subscription = this;
    var str = "Subscription:\n";
    str += "  subscriptionId          " + subscription.id + "\n";
    str += "  sessionId          " + subscription.getSessionId() + "\n";

    str += "  publishingEnabled  " + subscription.publishingEnabled + "\n";
    str += "  maxKeepAliveCount  " + subscription.maxKeepAliveCount + "\n";
    str += "  publishingInterval " + subscription.publishingInterval + "\n";
    str += "  lifeTimeCount      " + subscription.lifeTimeCount + "\n";
    str += "  maxKeepAliveCount  " + subscription.maxKeepAliveCount + "\n";
    return str;
};

/**
 * @method modify
 * @param param {Object}
 * @param param.requestedPublishingInterval  {Duration}  requestedPublishingInterval =0 means fastest possible
 * @param param.requestedLifetimeCount       {Counter}   requestedLifetimeCount      ===0 means no change
 * @param param.requestedMaxKeepAliveCount   {Counter}   requestedMaxKeepAliveCount  ===0 means no change
 * @param param.maxNotificationsPerPublish   {Counter}
 * @param param.priority                     {Byte}
 *
 */
Subscription.prototype.modify = function (param) {
    var subscription = this;

    // update diagnostic counter
    subscription.subscriptionDiagnostics.modifyCount += 1;

    var publishingInterval_old = subscription.publishingInterval;

    param.requestedPublishingInterval = param.requestedPublishingInterval || 0;
    param.requestedMaxKeepAliveCount = param.requestedMaxKeepAliveCount || subscription.maxKeepAliveCount;
    param.requestedLifetimeCount = param.requestedLifetimeCount || subscription.lifeTimeCount;

    subscription.publishingInterval = _adjust_publishing_interval(param.requestedPublishingInterval);
    subscription.maxKeepAliveCount = _adjust_maxKeepAliveCount(param.requestedMaxKeepAliveCount, subscription.publishingInterval);
    subscription.lifeTimeCount = _adjust_lifeTimeCount(param.requestedLifetimeCount, subscription.maxKeepAliveCount, subscription.publishingInterval);

    subscription.maxNotificationsPerPublish = param.maxNotificationsPerPublish;
    subscription.priority = param.priority;

    subscription.resetLifeTimeAndKeepAliveCounters();

    if (publishingInterval_old !== subscription.publishingInterval) {
        // todo
    }
    subscription._stop_timer();
    subscription._start_timer();

};

Subscription.prototype._stop_timer = function () {
    var subscription = this;
    if (subscription.timerId) {
        debugLog("Subscription#_stop_timer subscriptionId=".bgWhite.blue, subscription.id);
        clearInterval(subscription.timerId);
        subscription.timerId = null;
    }
};


Subscription.prototype._start_timer = function () {

    var subscription = this;
    debugLog("Subscription#_start_timer  subscriptionId=".bgWhite.blue, subscription.id, " publishingInterval = ", subscription.publishingInterval);

    assert(subscription.timerId === null);
    // from the spec:
    // When a Subscription is created, the first Message is sent at the end of the first publishing cycle to
    // inform the Client that the Subscription is operational. A NotificationMessage is sent if there are
    // Notifications ready to be reported. If there are none, a keep-alive Message is sent instead that
    // contains a sequence number of 1, indicating that the first NotificationMessage has not yet been sent.
    // This is the only time a keep-alive Message is sent without waiting for the maximum keep-alive count
    // to be reached, as specified in (f) above.


    // make sure that a keep-alive Message will be send at the end of the first publishing cycle
    // if there are no Notifications ready.
    subscription._keep_alive_counter = subscription.maxKeepAliveCount;

    assert(subscription.publishingInterval >= Subscription.minimumPublishingInterval);
    subscription.timerId = setInterval(subscription._tick.bind(subscription), subscription.publishingInterval);
};

// counter
Subscription.prototype._get_next_sequence_number = function () {
    return this._sequence_number_generator  ? this._sequence_number_generator.next() : 0;
};

// counter
Subscription.prototype._get_future_sequence_number = function () {
    return this._sequence_number_generator ? this._sequence_number_generator.future() : 0;
};

Subscription.prototype.setPublishingMode = function (publishingEnabled) {

    this.publishingEnabled = !!publishingEnabled;
    // update diagnostics
    if (this.publishingEnabled) {
        this.subscriptionDiagnostics.enableCount += 1;
    } else {
        this.subscriptionDiagnostics.disableCount += 1;
    }

    this.resetLifeTimeCounter();

    if (!publishingEnabled && this.state !== SubscriptionState.CLOSED) {
        this.state = SubscriptionState.NORMAL;
    }
    return StatusCodes.Good;
};


/**
 *  _publish_pending_notifications send a "notification" event:
 *
 * @method _publish_pending_notifications *
 * @private
 *
 */
Subscription.prototype._publish_pending_notifications = function () {

    var subscription = this;
    var publishEngine = subscription.publishEngine;
    var subscriptionId = subscription.id;

    // preconditions
    assert(publishEngine.pendingPublishRequestCount > 0);
    assert(subscription.hasPendingNotifications);

    function _count_notification_message(notifData) {

        if (notifData instanceof DataChangeNotification) {
            subscription.subscriptionDiagnostics.dataChangeNotificationsCount += 1;
        } else if (notifData instanceof EventNotificationList) {
            subscription.subscriptionDiagnostics.eventNotificationsCount += 1;
        } else {
            // TODO
        }
    }

    // todo : get rid of this....
    subscription.emit("notification");

    var notificationMessage = subscription._popNotificationToSend().notification;

    subscription.emit("notificationMessage", notificationMessage);


    assert(_.isArray(notificationMessage.notificationData));

    notificationMessage.notificationData.forEach(_count_notification_message);


    assert(notificationMessage.hasOwnProperty("sequenceNumber"));
    assert(notificationMessage.hasOwnProperty("notificationData"));

    var moreNotifications = (subscription.hasPendingNotifications);

    // update diagnostics
    if (subscription.subscriptionDiagnostics) {
        subscription.subscriptionDiagnostics.notificationsCount += 1;
        subscription.subscriptionDiagnostics.publishRequestCount += 1;
    }

    publishEngine.send_notification_message({
        subscriptionId: subscriptionId,
        sequenceNumber: notificationMessage.sequenceNumber,
        notificationData: notificationMessage.notificationData,
        moreNotifications: moreNotifications
    }, false);
    subscription.messageSent = true;
    subscription._unacknowledgedMessageCount++;

    subscription.resetLifeTimeAndKeepAliveCounters();

    if (doDebug) {
        debugLog("Subscription sending a notificationMessage subscriptionId=", subscriptionId,
            "sequenceNumber = ", notificationMessage.sequenceNumber.toString());
        // debugLog(notificationMessage.toString());
    }

    if (subscription.state !== SubscriptionState.CLOSED) {
        assert(notificationMessage.notificationData.length > 0, "We are not expecting a keep-alive message here");
        subscription.state = SubscriptionState.NORMAL;
        debugLog("subscription " + subscription.id + " set to NORMAL".bgYellow);
    }

};

Subscription.prototype._process_keepAlive = function () {
    var subscription = this;

    //xx assert(!self.publishingEnabled || (!self.hasPendingNotifications && !self.hasMonitoredItemNotifications));

    subscription.increaseKeepAliveCounter();

    if (subscription.keepAliveCounterHasExpired) {

        if (subscription._sendKeepAliveResponse()) {

            subscription.resetLifeTimeAndKeepAliveCounters();

        } else {
            debugLog("     -> subscription.state === LATE , because keepAlive Response cannot be send due to lack of PublishRequest");
            subscription.state = SubscriptionState.LATE;
        }
    }
};


Subscription.prototype.process_subscription = function () {

    var subscription = this;

    assert(subscription.publishEngine.pendingPublishRequestCount > 0);

    if (!subscription.publishingEnabled) {
        // no publish to do, except keep alive
        subscription._process_keepAlive();
        return;
    }

    if (!subscription.hasPendingNotifications && subscription.hasMonitoredItemNotifications) {
        // collect notification from monitored items
        subscription._harvestMonitoredItems();
    }

    // let process them first
    if (subscription.hasPendingNotifications) {

        subscription._publish_pending_notifications();

        if (subscription.state === SubscriptionState.NORMAL && subscription.hasPendingNotifications) {

            // istanbul ignore next
            if (doDebug) {
                debugLog("    -> pendingPublishRequestCount > 0 && normal state => re-trigger tick event immediately ");
            }

            // let process an new publish request
            setImmediate(subscription._tick.bind(subscription));
        }

    } else {
        subscription._process_keepAlive();
    }
};

function w(s, w) {
    return ("000" + s).substr(-w);
}

function t(d) {
    return w(d.getHours(), 2) + ":" + w(d.getMinutes(), 2) + ":" + w(d.getSeconds(), 2) + ":" + w(d.getMilliseconds(), 3);
}

/**
 * @method _tick
 * @private
 */
Subscription.prototype._tick = function () {

    var subscription = this;

    debugLog("Subscription#_tick  aborted=", subscription.aborted, "state=", subscription.state.toString());

    if (subscription.aborted) {
        //xx  console.log(" Log aborteds")
        //xx  // underlying channel has been aborted ...
        //xx self.publishEngine.cancelPendingPublishRequestBeforeChannelChange();
        //xx // let's still increase lifetime counter to detect timeout
    }


    if (subscription.state === SubscriptionState.CLOSED) {
        console.log("Warning: Subscription#_tick called while subscription is CLOSED");
        return;
    }

    subscription.discardOldSentNotifications();

    // istanbul ignore next
    if (doDebug) {
        debugLog((t(new Date()) + "  " + subscription._life_time_counter + "/" + subscription.lifeTimeCount + "   Subscription#_tick").cyan, "  processing subscriptionId=", subscription.id, "hasMonitoredItemNotifications = ", subscription.hasMonitoredItemNotifications, " publishingIntervalCount =", subscription.publishIntervalCount);
    }
    if (subscription.publishEngine._on_tick) {
        subscription.publishEngine._on_tick();
    }

    subscription.publishIntervalCount += 1;

    subscription.increaseLifeTimeCounter();

    if (subscription.lifeTimeHasExpired) {

        /* istanbul ignore next */
        if (doDebug) {
            debugLog("Subscription " + subscription.id + " has expired !!!!! => Terminating".red.bold);
        }
        /**
         * notify the subscription owner that the subscription has expired by exceeding its life time.
         * @event expired
         *
         */
        subscription.emit("expired");

        // notify new terminated status only when subscription has timeout.
        debugLog("adding StatusChangeNotification notification message for BadTimeout subscription = ", subscription.id);
        subscription._addNotificationMessage([new StatusChangeNotification({statusCode: StatusCodes.BadTimeout})]);

        // kill timer and delete monitored items and transfer pending notification messages
        subscription.terminate();

        return;

    }

    var publishEngine = subscription.publishEngine;

    // istanbul ignore next
    if (doDebug) {
        debugLog("Subscription#_tick  self._pending_notifications= ", subscription._pending_notifications.length);
    }

    if (publishEngine.pendingPublishRequestCount === 0 && (subscription.hasPendingNotifications || subscription.hasMonitoredItemNotifications)) {

        // istanbul ignore next
        if (doDebug) {
            debugLog("subscription set to LATE  hasPendingNotifications = ", subscription.hasPendingNotifications, " hasMonitoredItemNotifications =", subscription.hasMonitoredItemNotifications);
        }
        subscription.state = SubscriptionState.LATE;
        return;
    }

    if (publishEngine.pendingPublishRequestCount > 0) {

        if (subscription.hasPendingNotifications) {
            // simply pop pending notification and send it
            subscription.process_subscription();

        } else if (subscription.hasMonitoredItemNotifications) {
            subscription.process_subscription();

        } else {
            subscription._process_keepAlive();
        }
    } else {
        subscription._process_keepAlive();
    }
};


/**
 * @method _sendKeepAliveResponse
 * @private
 */
Subscription.prototype._sendKeepAliveResponse = function () {

    var subscription = this;
    var future_sequence_number = subscription._get_future_sequence_number();

    debugLog("     -> Subscription#_sendKeepAliveResponse subscriptionId", subscription.id);

    if (subscription.publishEngine.send_keep_alive_response(subscription.id, future_sequence_number)) {

        subscription.messageSent = true;

        /**
         * notify the subscription owner that a keepalive message has to be sent.
         * @event keepalive
         *
         */
        subscription.emit("keepalive", future_sequence_number);
        subscription.state = SubscriptionState.KEEPALIVE;

        return true;
    }
    return false;
};


/**
 * @method resetKeepAliveCounter
 * @private
 * Reset the Lifetime Counter Variable to the value specified for the lifetime of a Subscription in
 * the CreateSubscription Service( 5.13.2).
 */
Subscription.prototype.resetKeepAliveCounter = function () {
    var subscription = this;
    subscription._keep_alive_counter = 0;

    // istanbul ignore next
    if (doDebug) {
        debugLog("     -> subscriptionId", subscription.id, " Resetting keepAliveCounter = ", subscription._keep_alive_counter, subscription.maxKeepAliveCount);
    }
};

/**
 * @method increaseKeepAliveCounter
 * @private
 */
Subscription.prototype.increaseKeepAliveCounter = function () {
    var subscription = this;
    subscription._keep_alive_counter += 1;

    // istanbul ignore next
    if (doDebug) {
        debugLog("     -> subscriptionId", subscription.id, " Increasing keepAliveCounter = ", subscription._keep_alive_counter, subscription.maxKeepAliveCount);
    }
};

/**
 * @property keepAliveCounterHasExpired
 * @private
 * @type {Boolean} true if the keep alive counter has reach its limit.
 */
Subscription.prototype.__defineGetter__("keepAliveCounterHasExpired", function () {
    var subscription = this;
    return subscription._keep_alive_counter >= subscription.maxKeepAliveCount;
});


/**
 * Reset the Lifetime Counter Variable to the value specified for the lifetime of a Subscription in
 * the CreateSubscription Service( 5.13.2).
 * @method resetLifeTimeCounter
 * @private
 */
Subscription.prototype.resetLifeTimeCounter = function () {
    var subscription = this;
    subscription._life_time_counter = 0;
};
/**
 * @method increaseLifeTimeCounter
 * @private
 */
Subscription.prototype.increaseLifeTimeCounter = function () {
    var subscription = this;
    subscription._life_time_counter += 1;
};

/**
 *  True if the subscription life time has expired.
 *
 * @property lifeTimeHasExpired
 * @type {boolean} - true if the subscription life time has expired.
 */
Subscription.prototype.__defineGetter__("lifeTimeHasExpired", function () {
    var subscription = this;
    assert(subscription.lifeTimeCount > 0);
    return subscription._life_time_counter >= subscription.lifeTimeCount;
});

/**
 * number of milliseconds before this subscription times out (lifeTimeHasExpired === true);
 * @property timeToExpiration
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("timeToExpiration", function () {
    var subscription = this;
    return (subscription.lifeTimeCount - subscription._life_time_counter) * subscription.publishingInterval;
});

Subscription.prototype.__defineGetter__("timeToKeepAlive", function () {
    var subscription = this;
    return (subscription.maxKeepAliveCount - subscription._keep_alive_counter) * subscription.publishingInterval;
});

/**
 *
 *  the server invokes the resetLifeTimeAndKeepAliveCounters method of the subscription
 *  when the server  has send a Publish Response, so that the subscription
 *  can reset its life time counter.
 *
 * @method resetLifeTimeAndKeepAliveCounters
 *
 */
Subscription.prototype.resetLifeTimeAndKeepAliveCounters = function () {
    var subscription = this;
    subscription.resetLifeTimeCounter();
    subscription.resetKeepAliveCounter();
};

/**
 * Terminates the subscription.
 * @method terminate
 *
 * Calling this method will also remove any monitored items.
 *
 */
Subscription.prototype.terminate = function () {

    assert(arguments.length === 0);

    var subscription = this;
    debugLog("Subscription#terminate status", subscription.state);

    if (subscription.state === SubscriptionState.CLOSED) {
        // todo verify if asserting is required here
        return;
    }
    assert(subscription.state !== SubscriptionState.CLOSED, "terminate already called ?");

    // stop timer
    subscription._stop_timer();

    debugLog("terminating Subscription  ", subscription.id, " with ", subscription.monitoredItemCount, " monitored items");

    // dispose all monitoredItem
    var keys = Object.keys(subscription.monitoredItems);

    for (var key of keys) {
        var status = subscription.removeMonitoredItem(key);
        assert(status === StatusCodes.Good);
    }
    assert(subscription.monitoredItemCount === 0);


    if (subscription.$session) {
        subscription.$session._unexposeSubscriptionDiagnostics(subscription);
    }
    subscription.state = SubscriptionState.CLOSED;

    /**
     * notify the subscription owner that the subscription has been terminated.
     * @event "terminated"
     */
    subscription.emit("terminated");

    subscription.publishEngine.on_close_subscription(subscription);

};

Subscription.prototype.dispose = function () {

    var subscription = this;


    if (doDebug) {
        debugLog("Subscription#dispose" ,subscription.id, subscription.monitoredItemCount);
    }

    assert(subscription.monitoredItemCount === 0, "MonitoredItems haven't been  deleted first !!!");
    assert(subscription.timerId === null, "Subscription timer haven't been terminated");

    if (subscription.subscriptionDiagnostics) {
        subscription.subscriptionDiagnostics.$subscription = null;
        subscription.subscriptionDiagnostics = null;
    }

    subscription.publishEngine = null;
    subscription._pending_notifications = null;
    subscription._sent_notifications = null;

    subscription._sessionId = null;
    subscription._sequence_number_generator = null;

    subscription.$session = null;
    subscription.removeAllListeners();

    Subscription.registry.unregister(subscription);

};

Subscription.prototype.__defineGetter__("aborted", function () {
    var subscription = this;
    var session = subscription.$session;
    if (!session) {
        return true;
    }
    return session.aborted;
});

function assert_validNotificationData(n) {
    assert(
        n instanceof DataChangeNotification ||
        n instanceof EventNotificationList ||
        n instanceof StatusChangeNotification
    );
}

/**
 * @method _addNotificationMessage
 * @param notificationData {Array<DataChangeNotification|EventNotificationList|StatusChangeNotification>}
 */
Subscription.prototype._addNotificationMessage = function (notificationData) {

    assert(_.isArray(notificationData));
    assert(notificationData.length === 1 || notificationData.length === 2); // as per spec part 3.

    // istanbul ignore next
    if (doDebug) {
        debugLog("Subscription#_addNotificationMessage".yellow, notificationData.toString());
    }
    var subscription = this;
    assert(_.isObject(notificationData[0]));

    assert_validNotificationData(notificationData[0]);
    if (notificationData.length === 2) {
        assert_validNotificationData(notificationData[1]);
    }

    var notification_message = new NotificationMessage({
        sequenceNumber: subscription._get_next_sequence_number(),
        publishTime: new Date(),
        notificationData: notificationData
    });

    subscription._pending_notifications.push({
        notification: notification_message,
        start_tick: subscription.publishIntervalCount,
        publishTime: new Date(),
        sequenceNumber: notification_message.sequenceNumber
    });
    debugLog("pending notification to send ", subscription._pending_notifications.length);

};


Subscription.prototype.getMessageForSequenceNumber = function (sequenceNumber) {

    var subscription = this;

    function filter_func(e) {
        return e.sequenceNumber === sequenceNumber;
    }

    var notification_message = _.find(subscription._sent_notifications, filter_func);

    if (!notification_message) {
        return null;
    }
    return notification_message;

};

/**
 * Extract the next Notification that is ready to be sent to the client.
 * @method _popNotificationToSend
 * @return {NotificationMessage}  the Notification to send._pending_notifications
 */
Subscription.prototype._popNotificationToSend = function () {
    var subscription = this;
    assert(subscription._pending_notifications.length > 0);
    var notification_message = subscription._pending_notifications.shift();
    subscription._sent_notifications.push(notification_message);
    return notification_message;
};

/**
 * returns true if the notification has expired
 * @method notificationHasExpired
 * @param notification
 * @return {boolean}
 */
Subscription.prototype.notificationHasExpired = function (notification) {
    var subscription = this;
    assert(notification.hasOwnProperty("start_tick"));
    assert(_.isFinite(notification.start_tick + subscription.maxKeepAliveCount));
    return (notification.start_tick + subscription.maxKeepAliveCount) < subscription.publishIntervalCount;
};

var maxNotificationMessagesInQueue = 100;
/**
 * discardOldSentNotification find all sent notification message that have expired keep-alive
 * and destroy them.
 * @method discardOldSentNotifications
 * @private
 *
 * Subscriptions maintain a retransmission queue of sent  NotificationMessages.
 * NotificationMessages are retained in this queue until they are acknowledged or until they have
 * been in the queue for a minimum of one keep-alive interval.
 *
 */
Subscription.prototype.discardOldSentNotifications = function () {

    var subscription = this;

    // Sessions maintain a retransmission queue of sent NotificationMessages. NotificationMessages
    // are retained in this queue until they are acknowledged. The Session shall maintain a
    // retransmission queue size of at least two times the number of Publish requests per Session the
    // Server supports.  Clients are required to acknowledge NotificationMessages as they are received. In the
    // case of a retransmission queue overflow, the oldest sent NotificationMessage gets deleted. If a
    // Subscription is transferred to another Session, the queued NotificationMessages for this
    // Subscription are moved from the old to the new Session.
    if (maxNotificationMessagesInQueue <= subscription._sent_notifications.length) {
        debugLog("discardOldSentNotifications = ", subscription._sent_notifications.length);
        subscription._sent_notifications.splice(subscription._sent_notifications.length - maxNotificationMessagesInQueue);
    }
    //
    //var arr = _.filter(self._sent_notifications,function(notification){
    //   return self.notificationHasExpired(notification);
    //});
    //var results = arr.map(function(notification){
    //    return self.acknowledgeNotification(notification.sequenceNumber);
    //});
    //xx return results;
};

function getSequenceNumbers(arr) {
    return arr.map(function (e) {
        return e.notification.sequenceNumber;
    });
}

/**
 *  returns in an array the sequence numbers of the notifications that haven't been
 *  acknowledged yet.
 *
 *  @method getAvailableSequenceNumbers
 *  @return {Integer[]}
 *
 */
Subscription.prototype.getAvailableSequenceNumbers = function () {
    var subscription = this;
    var availableSequenceNumbers = getSequenceNumbers(subscription._sent_notifications);
    return availableSequenceNumbers;
};


/**
 * @method acknowledgeNotification
 * @param sequenceNumber {Number}
 * @return {StatusCode}
 */
Subscription.prototype.acknowledgeNotification = function (sequenceNumber) {
    var subscription = this;

    var foundIndex = -1;
    _.find(subscription._sent_notifications, function (e, index) {
        if (e.sequenceNumber === sequenceNumber) {
            foundIndex = index;
        }
    });
    if (foundIndex === -1) {
        if (doDebug) {
            debugLog("acknowledging sequence FAILED !!! ".red, sequenceNumber.toString().cyan);
        }
        return StatusCodes.BadSequenceNumberUnknown;
    } else {
        if (doDebug) {
            debugLog("acknowledging sequence ".yellow, sequenceNumber.toString().cyan);
        }
        subscription._sent_notifications.splice(foundIndex, 1);
        subscription._unacknowledgedMessageCount--;
        return StatusCodes.Good;
    }
};


/**
 *
 * @property pendingNotificationsCount  - number of pending notifications
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("pendingNotificationsCount", function () {
    return this._pending_notifications ? this._pending_notifications.length : 0;
});

/**
 * return True is there are pending notifications for this subscription. (i.e moreNotifications)
 *
 * @property hasPendingNotifications
 * @type {Boolean}
 */
Subscription.prototype.__defineGetter__("hasPendingNotifications", function () {
    var subscription = this;
    return subscription.pendingNotificationsCount > 0;
});

/**
 * number of sent notifications
 * @property sentNotificationsCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("sentNotificationsCount", function () {
    return this._sent_notifications.length;
});

/**
 * number of monitored items.
 * @property monitoredItemCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("monitoredItemCount", function () {
    return Object.keys(this.monitoredItems).length;
});

/**
 * number of disabled monitored items.
 * @property disabledMonitoredItemCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("disabledMonitoredItemCount", function () {

    return _.reduce(_.values(this.monitoredItems), function (cumul, monitoredItem) {
        return cumul + ((monitoredItem.monitoringMode === MonitoringMode.Disabled) ? 1 : 0);
    }, 0);

});

/**
 * The number of unacknowledged messages saved in the republish queue.
 * @property unacknowledgedMessageCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("unacknowledgedMessageCount", function () {
    var subscription = this;
    return subscription._unacknowledgedMessageCount;
});


var MonitoredItem = require("./monitored_item").MonitoredItem;


var MonitoredItemCreateRequest = require("node-opcua-service-subscription").MonitoredItemCreateRequest;


/**
 * adjust monitored item sampling interval
 *  - an samplingInterval ===0 means that we use a event-base model ( no sampling)
 *  - otherwise the sampling is adjusted
 *
 * @method adjustSamplingInterval
 * @param samplingInterval
 * @param node
 * @return {number|*}
 * @private
 */
Subscription.prototype.adjustSamplingInterval = function (samplingInterval, node) {

    var subscription = this;

    if (samplingInterval < 0) {
        // - The value -1 indicates that the default sampling interval defined by the publishing
        //   interval of the Subscription is requested.
        // - Any negative number is interpreted as -1.
        samplingInterval = subscription.publishingInterval;

    } else if (samplingInterval === 0) {

        // OPCUA 1.0.3 Part 4 - 5.12.1.2
        // The value 0 indicates that the Server should use the fastest practical rate.

        // The fastest supported sampling interval may be equal to 0, which indicates
        // that the data item is exception-based rather than being sampled at some period.
        // An exception-based model means that the underlying system does not require sampling and reports data changes.

        var dataValueSamplingInterval = node.readAttribute(SessionContext.defaultContext, AttributeIds.MinimumSamplingInterval);

        // TODO if attributeId === AttributeIds.Value : sampling interval required here
        if (dataValueSamplingInterval.statusCode === StatusCodes.Good) {
            // node provides a Minimum sampling interval ...
            samplingInterval = dataValueSamplingInterval.value.value;
            assert(samplingInterval >= 0 && samplingInterval <= MonitoredItem.maximumSamplingInterval);

            // note : at this stage, a samplingInterval===0 means that the data item is really exception-based

        }

    } else if (samplingInterval < MonitoredItem.minimumSamplingInterval) {

        samplingInterval = MonitoredItem.minimumSamplingInterval;

    } else if (samplingInterval > MonitoredItem.maximumSamplingInterval) {

        // If the requested samplingInterval is higher than the
        // maximum sampling interval supported by the Server, the maximum sampling
        // interval is returned.
        samplingInterval = MonitoredItem.maximumSamplingInterval;
    }

    var node_minimumSamplingInterval = (node && node.minimumSamplingInterval) ? node.minimumSamplingInterval : 0;
    samplingInterval = Math.max(samplingInterval, node_minimumSamplingInterval);

    return samplingInterval;
};


var checkSelectClauses = require("node-opcua-address-space").checkSelectClauses;

function analyseEventFilterResult(node, eventFilter) {
    assert(eventFilter instanceof EventFilter);
    var selectClauseResults = checkSelectClauses(node, eventFilter.selectClauses);

    var whereClauseResult = new subscription_service.ContentFilterResult();

    return new subscription_service.EventFilterResult({
        selectClauseResults: selectClauseResults,
        selectClauseDiagnosticInfos: [],
        whereClauseResult: whereClauseResult
    });
}

function analyseDataChangeFilterResult(node, dataChangeFilter) {
    assert(dataChangeFilter instanceof subscription_service.DataChangeFilter);
    // the opcua specification doesn't provide dataChangeFilterResult
    return null;
}

function analyseAggregateFilterResult(node, aggregateFilter) {
    assert(aggregateFilter instanceof subscription_service.AggregateFilter);
    return new subscription_service.AggregateFilterResult({});
}


function _process_filter(node, filter) {

    if (!filter) {
        return null;
    }

    if (filter instanceof EventFilter) {
        return analyseEventFilterResult(node, filter);
    } else if (filter instanceof DataChangeFilter) {
        return analyseDataChangeFilterResult(node, filter);
    } else if (filter instanceof AggregateFilter) {
        return analyseAggregateFilterResult(node, filter);
    }
    // istanbul ignore next
    throw new Error("invalid filter");
}


/**
 *
 * @param addressSpace
 * @param timestampsToReturn
 * @param monitoredItemCreateRequest
 * @returns {monitoredItemCreateResult}
 */
Subscription.prototype.createMonitoredItem = function (addressSpace, timestampsToReturn, monitoredItemCreateRequest) {

    var subscription = this;
    assert(addressSpace.constructor.name === "AddressSpace");
    assert(monitoredItemCreateRequest instanceof MonitoredItemCreateRequest);


    function handle_error(statusCode) {
        return new subscription_service.MonitoredItemCreateResult({statusCode: statusCode});
    }

    var itemToMonitor = monitoredItemCreateRequest.itemToMonitor;

    var node = addressSpace.findNode(itemToMonitor.nodeId);
    if (!node) {
        return handle_error(StatusCodes.BadNodeIdUnknown);
    }


    if (itemToMonitor.attributeId === AttributeIds.Value && !(node instanceof UAVariable)) {
        // AttributeIds.Value is only valid for monitoring value of UAVariables.
        return handle_error(StatusCodes.BadAttributeIdInvalid);
    }


    if (itemToMonitor.attributeId === AttributeIds.INVALID) {
        return handle_error(StatusCodes.BadAttributeIdInvalid);
    }

    if (!itemToMonitor.indexRange.isValid()) {
        return handle_error(StatusCodes.BadIndexRangeInvalid);
    }

    // check dataEncoding applies only on Values
    if (itemToMonitor.dataEncoding.name && itemToMonitor.attributeId !== AttributeIds.Value) {
        return handle_error(StatusCodes.BadDataEncodingInvalid);
    }

    // check dataEncoding
    if (!is_valid_dataEncoding(itemToMonitor.dataEncoding)) {
        return handle_error(StatusCodes.BadDataEncodingUnsupported);
    }

    // check that item can be read by current user session

    // filter
    var requestedParameters = monitoredItemCreateRequest.requestedParameters;
    var filter = requestedParameters.filter;
    var statusCodeFilter = validateFilter(filter, itemToMonitor, node);
    if (statusCodeFilter !== StatusCodes.Good) {
        return handle_error(statusCodeFilter);
    }
    //xx var monitoringMode      = monitoredItemCreateRequest.monitoringMode; // Disabled, Sampling, Reporting
    //xx var requestedParameters = monitoredItemCreateRequest.requestedParameters;

    var monitoredItemCreateResult = subscription._createMonitoredItemStep2(timestampsToReturn, monitoredItemCreateRequest, node);

    assert(monitoredItemCreateResult.statusCode === StatusCodes.Good);

    var monitoredItem = subscription.getMonitoredItem(monitoredItemCreateResult.monitoredItemId);
    assert(monitoredItem);

    // TODO: fix old way to set node. !!!!
    monitoredItem.setNode(node);

    subscription.emit("monitoredItem", monitoredItem, itemToMonitor);

    subscription._createMonitoredItemStep3(monitoredItem, monitoredItemCreateRequest);

    return monitoredItemCreateResult;

};

var g_monitoredItemId = 1;

function getNextMonitoredItemId() {
    return g_monitoredItemId++;
}

/**
 *
 * @method _createMonitoredItemStep2
 * @param timestampsToReturn
 * @param {MonitoredItemCreateRequest} monitoredItemCreateRequest - the parameters describing the monitored Item to create
 * @param node {BaseNode}
 * @return {subscription_service.MonitoredItemCreateResult}
 * @private
 */
Subscription.prototype._createMonitoredItemStep2 = function (timestampsToReturn, monitoredItemCreateRequest, node) {

    var subscription = this;

    // note : most of the parameter inconsistencies shall have been handled by the caller
    // any error here will raise an assert here

    assert(monitoredItemCreateRequest instanceof MonitoredItemCreateRequest);
    var itemToMonitor = monitoredItemCreateRequest.itemToMonitor;

    //xx check if attribute Id invalid (we only support Value or EventNotifier )
    //xx assert(itemToMonitor.attributeId !== AttributeIds.INVALID);

    subscription.monitoredItemIdCounter += 1;


    var monitoredItemId = getNextMonitoredItemId();

    var requestedParameters = monitoredItemCreateRequest.requestedParameters;

    // adjust requestedParameters.samplingInterval
    requestedParameters.samplingInterval = subscription.adjustSamplingInterval(requestedParameters.samplingInterval, node);

    // reincorporate monitoredItemId and itemToMonitor into the requestedParameters
    requestedParameters.monitoredItemId = monitoredItemId;
    requestedParameters.itemToMonitor = itemToMonitor;


    var monitoredItem = new MonitoredItem(requestedParameters);
    monitoredItem.timestampsToReturn = timestampsToReturn;
    monitoredItem.$subscription = subscription;

    assert(monitoredItem.monitoredItemId === monitoredItemId);
    subscription.monitoredItems[monitoredItemId] = monitoredItem;

    var filterResult = _process_filter(node, requestedParameters.filter);


    var monitoredItemCreateResult = new subscription_service.MonitoredItemCreateResult({
        statusCode: StatusCodes.Good,
        monitoredItemId: monitoredItemId,
        revisedSamplingInterval: monitoredItem.samplingInterval,
        revisedQueueSize: monitoredItem.queueSize,
        filterResult: filterResult
    });
    return monitoredItemCreateResult;
};


Subscription.prototype._createMonitoredItemStep3 = function (monitoredItem, monitoredItemCreateRequest) {

    assert(monitoredItem.monitoringMode === MonitoringMode.Invalid);
    assert(_.isFunction(monitoredItem.samplingFunc));
    var monitoringMode = monitoredItemCreateRequest.monitoringMode; // Disabled, Sampling, Reporting
    monitoredItem.setMonitoringMode(monitoringMode);

};

/**
 * get a monitoredItem by Id.
 * @method getMonitoredItem
 * @param monitoredItemId  {Number} the id of the monitored item to get.
 * @return {MonitoredItem}
 */
Subscription.prototype.getMonitoredItem = function (monitoredItemId) {
    assert(_.isFinite(monitoredItemId));
    var subscription = this;
    return subscription.monitoredItems[monitoredItemId];
};

/**
 * getMonitoredItems is used to get information about monitored items of a subscription.Its intended
 * use is defined in Part 4. This method is the implementation of the Standard OPCUA GetMonitoredItems Method.
 * @method getMonitoredItems
 * @param  result.serverHandles {Int32[]} Array of serverHandles for all MonitoredItems of the subscription identified by subscriptionId.
 *         result.clientHandles {Int32[]} Array of clientHandles for all MonitoredItems of the subscription identified by subscriptionId.
 *         result.statusCode    {StatusCode}
 * from spec:
 * This method can be used to get the  list of monitored items in a subscription if CreateMonitoredItems failed due to
 * a network interruption and the client does not know if the creation succeeded in the server.
 *
 */
Subscription.prototype.getMonitoredItems = function (/*out*/ result) {

    result = result || {};
    var subscription = this;
    result.serverHandles = [];
    result.clientHandles = [];
    result.statusCode = StatusCodes.Good;

    Object.keys(subscription.monitoredItems).forEach(function (monitoredItemId) {

        var monitoredItem = subscription.getMonitoredItem(monitoredItemId);

        result.clientHandles.push(monitoredItem.clientHandle);
        // TODO:  serverHandle is defined anywhere in the OPCUA Specification 1.02
        //        I am not sure what shall be reported for serverHandle...
        //        using monitoredItem.monitoredItemId instead...
        //        May be a clarification in the OPCUA Spec is required.
        result.serverHandles.push(monitoredItemId);

    });
    return result;
};

MonitoredItem.prototype.resendInitialValues = function () {
    // tte first Publish response(s) after the TransferSubscriptions call shall contain the current values of all
    // Monitored Items in the Subscription where the Monitoring Mode is set to Reporting.
    // the first Publish response after the TransferSubscriptions call shall contain only the value changes since
    // the last Publish response was sent.
    // This parameter only applies to MonitoredItems used for monitoring Attribute changes.
    var subscription = this;
    subscription._stop_sampling();
    subscription._start_sampling(true);
};

Subscription.prototype.resendInitialValues = function () {
    var subscription = this;
    _.forEach(subscription.monitoredItems, function (monitoredItem/*,monitoredItemId*/) {
        monitoredItem.resendInitialValues();
    });
};


/**
 * remove a monitored Item from the subscription.
 * @method removeMonitoredItem
 * @param monitoredItemId  {Number} the id of the monitored item to get.
 */
Subscription.prototype.removeMonitoredItem = function (monitoredItemId) {

    debugLog("Removing monitoredIem ", monitoredItemId);

    assert(_.isFinite(monitoredItemId));
    var subscription = this;
    if (!subscription.monitoredItems.hasOwnProperty(monitoredItemId)) {
        return StatusCodes.BadMonitoredItemIdInvalid;
    }

    var monitoredItem = subscription.monitoredItems[monitoredItemId];

    monitoredItem.terminate();

    monitoredItem.dispose();

    /**
     *
     * notify that a monitored item has been removed from the subscription
     * @event removeMonitoredItem
     * @param monitoredItem {MonitoredItem}
     */
    subscription.emit("removeMonitoredItem", monitoredItem);

    delete subscription.monitoredItems[monitoredItemId];

    return StatusCodes.Good;

};


/**
 * @property hasMonitoredItemNotifications true if monitored Item have uncollected Notifications
 * @type {Boolean}
 */
Subscription.prototype.__defineGetter__("hasMonitoredItemNotifications", function () {
    var subscription = this;
    if (subscription._hasMonitoredItemNotifications) {
        return true;
    }
    var keys = Object.keys(subscription.monitoredItems);
    var i, key;
    var n = keys.length;
    for (i = 0; i < n; i++) {
        key = keys[i];
        var monitoredItem = subscription.monitoredItems[key];
        if (monitoredItem.hasMonitoredItemNotifications) {
            subscription._hasMonitoredItemNotifications = true;
            return true;
        }
    }
    return false;
});

/**
 * @method extract_notifications_chunk
 * extract up to maxNotificationsPerPublish notifications
 * @param monitoredItems {Array<MonitoredItem>}
 * @param maxNotificationsPerPublish {Number} the maximum number of notification to extract
 * @return {Array<MonitoredItem>}
 * @static
 * @private
 */
function extract_notifications_chunk(monitoredItems, maxNotificationsPerPublish) {

    var n = maxNotificationsPerPublish === 0 ?
        monitoredItems.length :
        Math.min(monitoredItems.length, maxNotificationsPerPublish);

    var chunk_monitoredItems = [];
    while (n) {
        chunk_monitoredItems.push(monitoredItems.shift());
        n--;
    }
    return chunk_monitoredItems;
}

function add_all_in(notifications, all_notifications) {
    for (var i = 0; i < notifications.length; i++) {
        var n = notifications[i];
        all_notifications.push(n);
    }
}

function filter_instanceof(Class, e) {
    return (e instanceof Class);
}

// collect DataChangeNotification
Subscription.prototype._collectNotificationData = function () {

    var subscription = this;
    var notifications = [];

    // reset cache ...
    subscription._hasMonitoredItemNotifications = false;

    var all_notifications = new Dequeue();

    // visit all monitored items
    var keys = Object.keys(subscription.monitoredItems);
    var i, key;
    var n = keys.length;
    for (i = 0; i < n; i++) {
        key = keys[i];
        var monitoredItem = subscription.monitoredItems[key];
        notifications = monitoredItem.extractMonitoredItemNotifications();
        add_all_in(notifications, all_notifications);
    }

    var notificationsMessage = [];

    while (all_notifications.length > 0) {

        // split into one or multiple dataChangeNotification with no more than
        //  self.maxNotificationsPerPublish monitoredItems
        var notifications_chunk = extract_notifications_chunk(all_notifications, subscription.maxNotificationsPerPublish);

        // separate data for DataChangeNotification (MonitoredItemNotification) from data for EventNotificationList(EventFieldList)
        var dataChangedNotificationData = notifications_chunk.filter(filter_instanceof.bind(null, subscription_service.MonitoredItemNotification));
        var eventNotificationListData = notifications_chunk.filter(filter_instanceof.bind(null, subscription_service.EventFieldList));

        assert(notifications_chunk.length === dataChangedNotificationData.length + eventNotificationListData.length);

        notifications = [];

        // add dataChangeNotification
        if (dataChangedNotificationData.length) {
            var dataChangeNotification = new DataChangeNotification({
                monitoredItems: dataChangedNotificationData,
                diagnosticInfos: []
            });
            notifications.push(dataChangeNotification);
        }

        // add dataChangeNotification
        if (eventNotificationListData.length) {
            var eventNotificationList = new EventNotificationList({
                events: eventNotificationListData
            });

            notifications.push(eventNotificationList);
        }

        assert(notifications.length === 1 || notifications.length === 2);
        notificationsMessage.push(notifications);
    }

    assert(notificationsMessage instanceof Array);
    return notificationsMessage;
};

Subscription.prototype._harvestMonitoredItems = function () {

    var subscription = this;

    // Only collect data change notification for the time being
    var notificationData = subscription._collectNotificationData();
    assert(notificationData instanceof Array);

    // istanbul ignore next
    if (doDebug) {
        debugLog("Subscription#_harvestMonitoredItems =>", notificationData.length);
    }
    notificationData.forEach(function (notificationMessage) {
        subscription._addNotificationMessage(notificationMessage);
    });
    subscription._hasMonitoredItemNotifications = false;

};
Subscription.prototype.__defineGetter__("subscriptionId", function () {
    return this.id;
});


Subscription.prototype.notifyTransfer = function () {

    // OPCUA UA Spec 1.0.3 : part 3 - page 82 - 5.13.7 TransferSubscriptions:
    // If the Server transfers the Subscription to the new Session, the Server shall issue a StatusChangeNotification
    // notificationMessage with the status code Good_SubscriptionTransferred to the old Session.
    var subscription = this;

    debugLog(" Subscription => Notifying Transfer                                  ".red);

    var notificationData = [new StatusChangeNotification({statusCode: StatusCodes.GoodSubscriptionTransferred})];

    subscription.publishEngine.send_notification_message({
        subscriptionId: subscription.id,
        sequenceNumber: subscription._get_next_sequence_number(),
        notificationData: notificationData,
        moreNotifications: false
    }, true);

};


exports.Subscription = Subscription;
