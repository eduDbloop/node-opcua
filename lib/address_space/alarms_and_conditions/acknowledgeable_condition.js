/**
 * @module opcua.address_space.AlarmsAndConditions
 */
require("requirish")._(module);

const assert = require("better-assert");
const _ = require("underscore");
const UAVariable = require("lib/address_space/ua_variable").UAVariable;
const Variant = require("lib/datamodel/variant").Variant;
const DataType = require("lib/datamodel/variant").DataType;
const StatusCodes = require("lib/datamodel/opcua_status_code").StatusCodes;

const UAObjectType = require("lib/address_space/ua_object_type").UAObjectType;
const UAObject = require("lib/address_space/ua_object").UAObject;
const AttributeIds = require("lib/datamodel/attributeIds").AttributeIds;
const LocalizedText = require("lib/datamodel/localized_text").LocalizedText;


const util = require("util");
const NodeClass = require("lib/datamodel/nodeclass").NodeClass;
const resolveNodeId = require("lib/datamodel/nodeid").resolveNodeId;
const NodeId = require("lib/datamodel/nodeid").NodeId;

const AddressSpace = require("lib/address_space/address_space").AddressSpace;
const UATwoStateVariable = require("lib/address_space/ua_two_state_variable").UATwoStateVariable;
assert(UATwoStateVariable);
const conditions =require("./condition");
const UAConditionBase = conditions.UAConditionBase;
const ConditionSnapshot = conditions.ConditionSnapshot;

function _getValueAsBoolean(node) {
    assert(!node.id);
    return !!node.readValue().value.value;
}

const coerceLocalizedText = require("lib/datamodel/localized_text").coerceLocalizedText;

ConditionSnapshot.prototype.isCurrentBranch = function(){
    return this._get_var("branchId") === NodeId.NullNodeId;
};
/**
 * @class ConditionSnapshot
 * @param varName
 * @param value
 * @private
 */
ConditionSnapshot.prototype._set_twoStateVariable = function(varName,value) {

    value = !!value;
    const self = this;

    const hrKey = ConditionSnapshot.normalizeName(varName);
    const idKey = ConditionSnapshot.normalizeName(varName)+".id";

    const variant = new Variant({ dataType: DataType.Boolean , value});
    self._map[idKey] = variant;

    // also change varName with human readable text
    const twoStateNode = self._node_index[hrKey];
    assert(twoStateNode);
    assert(twoStateNode instanceof UATwoStateVariable);

    const txt = value ? twoStateNode._trueState : twoStateNode._falseState;

    const hrValue = new Variant({
        dataType: DataType.LocalizedText,
        value:  coerceLocalizedText(txt)
    });
    self._map[hrKey] = hrValue;

    const node = self._node_index[idKey];

    // also change ConditionNode if we are on currentBranch
    if (self.isCurrentBranch()) {
        assert(twoStateNode instanceof UATwoStateVariable);
        twoStateNode.setValue(value);
        //xx console.log("Is current branch", twoStateNode.toString(),variant.toString());
        //xx console.log("  = ",twoStateNode.getValue());
    }
    self.emit("value_changed",node,variant);

};

ConditionSnapshot.prototype._get_twoStateVariable = function(varName) {
    const self = this;
    const key = ConditionSnapshot.normalizeName(varName)+".id";
    const variant = self._map[key];

    // istanbul ignore next
    if (!variant) {
        throw new Error("Cannot find TwoStateVariable with name " + varName);
    }
    return variant.value;
};

const _setAckedState = (self, requestedAckedState, eventId, comment) => {

    assert(self instanceof ConditionSnapshot);

    const ackedState = self.getAckedState();

    if (ackedState && requestedAckedState) {
        return StatusCodes.BadConditionBranchAlreadyAcked;
    }
    self._set_twoStateVariable("ackedState",requestedAckedState);
    return StatusCodes.Good;
};

ConditionSnapshot.prototype.getAckedState = function()
{
    const self = this;
    if (!self.condition.ackedState) {
        const condition = self.condition;
        throw new Error("Node "+ condition.browseName.toString()+
            " of type "+ condition.typeDefinitionObj.browseName.toString()+
            " has no AckedState");
    }
    return self._get_twoStateVariable("ackedState");
};

ConditionSnapshot.prototype.setAckedState = function(ackedState) {
    ackedState = !!ackedState;
    const self = this;
    //xx var oldAckedState = self.getAckedState();
    _setAckedState(self, ackedState);
    //xx if (!oldAckedState && ackedState) {
    //xx     // need to set unconfirmed
    //xx     self.setConfirmedState(false);
    //xx }
};

ConditionSnapshot.prototype.getConfirmedState = function()
{
    const self = this;
    assert(self.condition.confirmedState,"Must have a confirmed state");
    return self._get_twoStateVariable("confirmedState");
};

ConditionSnapshot.prototype.setConfirmedState = function(confirmedState) {
    confirmedState = !!confirmedState;
    const self = this;
    assert(self.condition.confirmedState,"Must have a confirmed state.  Add ConfirmedState to the optionals");
    // todo deal with Error code BadConditionBranchAlreadyConfirmed
    self._set_twoStateVariable("confirmedState",confirmedState);
};

/**
 * @class UAAcknowledgeableConditionBase
 * @constructor
 * @extends UAConditionBase
 */
function UAAcknowledgeableConditionBase() {

}
util.inherits(UAAcknowledgeableConditionBase,UAConditionBase);


UAAcknowledgeableConditionBase.prototype._populate_EventData = function(eventData) {
    const self = this;
    UAConditionBase.prototype._populate_EventData.call(self,eventData);
    self._populate_EventData_with_AcknowledgeableConditionTypeElements(eventData);
};

UAAcknowledgeableConditionBase.prototype._populate_EventData_with_AcknowledgeableConditionTypeElements = function(eventData) {
    const self = this;
    const data = {
        // -----------------------------------------------------------
        // AcknowledgeableConditionType
        // -----------------------------------------------------------
        ackedState:     self.ackedState.readValue().value,
        confirmedState: self.confirmedState.readValue().value
    };
    eventData= _.extend(eventData,data);
};


UAAcknowledgeableConditionBase.prototype._raiseAuditConditionAcknowledgeEvent = function(branch) {


    // raise the AuditConditionAcknowledgeEventType
    const eventData = {

        // EventType
        eventId:  { dataType: DataType.ByteString, value: branch.getEventId() },
        //xx branchId: branch.branchId.readValue().value,
        // AuditEventType
        actionTimeStamp: { dataType: DataType.DateTime, value : new Date() },
        status: { dataType: DataType.StatusCodes, value: StatusCodes.Good },
        serverId: {},
        clientAuditEntryId: {},
        clientUserId: {},
        methodId: {},
        inputArguments: {},
        comment:   {dataType: DataType.LocalizedText, value: branch.getComment() }
    };
    this.raiseEvent("AuditConditionAcknowledgeEventType",eventData);

};

UAAcknowledgeableConditionBase.prototype._raiseAuditConditionConfirmEvent = function(branch) {

    // raise the AuditConditionConfirmEventType
    const eventData = {

        // EventType
        eventId:  { dataType: DataType.ByteString, value: branch.getEventId() },
        //xx branchId: branch.branchId.readValue().value,
        // AuditEventType
        actionTimeStamp: { dataType: DataType.DateTime, value : new Date() },
        status: { dataType: DataType.StatusCodes, value: StatusCodes.Good },
        serverId: {},
        clientAuditEntryId: {},
        clientUserId: {},
        methodId: {},
        inputArguments: {},
        comment:   {dataType: DataType.LocalizedText, value: branch.getComment() }
    };
    this.raiseEvent("AuditConditionConfirmEventType",eventData);

};


UAAcknowledgeableConditionBase.prototype._acknowledge_branch = function (eventId,comment,branch,message) {

    assert(typeof(message) === "string");

    const conditionNode = this;

    if(conditionNode.confirmedState) {
        // alarm has a confirmed state !
        // we should be waiting for confirmation now
        branch.setConfirmedState(false);
        branch.setRetain(true);
    } else {
        branch.setRetain(false);
    }

    const statusCode = _setAckedState(branch,true,eventId,comment);
    if (statusCode != StatusCodes.Good) {
        return statusCode;
    }

    branch.setComment(comment);

    conditionNode.raiseNewBranchState(branch);

    //xx conditionNode._raiseAuditConditionCommentEvent("Method/Acknowledge",eventId,comment);
    conditionNode._raiseAuditConditionAcknowledgeEvent(branch);


    /**
     * @event acknowledged
     * @param  eventId   {Buffer|null}
     * @param  comment   {LocalizedText}
     * @param  branch    {ConditionSnapshot}
     * raised when the alarm branch has been acknowledged
     */
    conditionNode.emit("acknowledged",eventId,comment,branch);

};



function _acknowledge_method(inputArguments,context,callback) {

    UAConditionBase.with_condition_method(inputArguments, context, callback,(eventId, comment, branch, conditionNode) => {

        // precondition checking
        assert(!eventId || eventId instanceof Buffer,"must have a valid eventId or  null");
        assert(comment instanceof LocalizedText, "expecting a comment as LocalizedText");
        assert(conditionNode instanceof UAAcknowledgeableConditionBase);
        conditionNode._acknowledge_branch(eventId,comment,branch,"Method/Acknowledged");
        return StatusCodes.Good;
    });
}

/**
 * @method _confirm_branch
 * @param eventId
 * @param comment
 * @param branch
 * @param message
 * @private
 */
UAAcknowledgeableConditionBase.prototype._confirm_branch = function _confirm_branch(eventId,comment,branch,message) {

    assert(typeof(message) == "string");
    assert(comment instanceof LocalizedText);

    const conditionNode = this;
    var eventId = branch.getEventId();
    assert(branch.getEventId().toString("hex") === eventId.toString("hex"));
    branch.setConfirmedState(true);
    branch.setRetain(false);

    branch.setComment(comment);

    conditionNode._raiseAuditConditionCommentEvent(message,eventId,comment);
    conditionNode._raiseAuditConditionConfirmEvent(branch);

    conditionNode.raiseNewBranchState(branch);

    /**
     * @event confirmed
     * @param  eventId
     * @param  comment
     * @param  eventId
     * raised when the alarm branch has been confirmed
     */
    conditionNode.emit("confirmed",eventId,comment,branch);

};

/**
 * @method autoConfirmBranch
 * @param branch
 * @param comment
 */
UAAcknowledgeableConditionBase.prototype.autoConfirmBranch = function(branch,comment) {
    assert(branch instanceof ConditionSnapshot);
    assert(!branch.getConfirmedState(),"already confirmed ?");
    const conditionNode = this;
    const eventId = branch.getEventId();
    console.log("autoConfirmBranch getAckedState ",branch.getAckedState());
    conditionNode._confirm_branch(eventId,comment,branch,"Server/Confirm");
};

/**
 * @method acknowledgeAndAutoConfirmBranch
 * @param branch
 * @param comment
 */
UAAcknowledgeableConditionBase.prototype.acknowledgeAndAutoConfirmBranch = function(branch,comment) {

    comment = LocalizedText.coerce(comment);
    const eventId = branch.getEventId();
    branch.setRetain(false);
    this._acknowledge_branch(eventId,comment,branch,"Server/Acknowledge");
    this.autoConfirmBranch(branch,comment);
};
/**
 *
 * StatusCodes :
 *
 * @param inputArguments {Variant[]}
 * @param context        {Object}
 * @param callback       {Function}
 * @private
 */
function _confirm_method(inputArguments,context,callback) {

    UAConditionBase.with_condition_method(inputArguments, context, callback,(eventId, comment, branch, conditionNode) => {

        assert(eventId instanceof Buffer);
        assert(branch.getEventId()  instanceof Buffer);
        assert(branch.getEventId().toString("hex") === eventId.toString("hex"));

        if (branch.getConfirmedState()) {
            return  StatusCodes.BadConditionBranchAlreadyConfirmed;
        }
        conditionNode._confirm_branch(eventId,comment,branch,"Method/Confirm");
        return StatusCodes.Good;
    });
}

exports.UAAcknowledgeableConditionBase = UAAcknowledgeableConditionBase;

/**
 * @method (static)UAAcknowledgeableConditionBase.instantiate
 * @param addressSpace    {AddressSpace}
 * @param conditionTypeId {String|NodeId}
 * @param options
 * @param data
 * @return {UAAcknowledgeableConditionBase}
 */
UAAcknowledgeableConditionBase.instantiate = (addressSpace, conditionTypeId, options, data) => {

    //xx assert(options.conditionOf,"must provide a conditionOf Node");

    const conditionNode = UAConditionBase.instantiate(addressSpace, conditionTypeId, options, data);
    Object.setPrototypeOf(conditionNode,UAAcknowledgeableConditionBase.prototype);

    // ----------------------- Install Acknowledge-able Condition stuff
    // install ackedState - Mandatory
    /**
     * @property ackedState
     * @type TwoStateVariable
     */
    AddressSpace._install_TwoStateVariable_machinery(conditionNode.ackedState,{
        trueState: "Acknowledged",
        falseState: "Unacknowledged"
    });

    /**
     * @property acknowledge
     * @type UAMethod
     */
    conditionNode.acknowledge.bindMethod(_acknowledge_method);

    // install confirmedState - Optional
    /**
     * @property confirmedState
     * @type TwoStateVariable
     */
    if (conditionNode.confirmedState) {
        AddressSpace._install_TwoStateVariable_machinery(conditionNode.confirmedState,{
            trueState: "Confirmed",
            falseState: "Unconfirmed"
        });
    }

    // install confirm Method - Optional
    /**
     * @property confirm
     * @type UAMethod
     */
    if (conditionNode.confirm) {
        conditionNode.confirm.bindMethod(_confirm_method);
    }
    assert(conditionNode instanceof UAAcknowledgeableConditionBase);
    return conditionNode;
};

UAAcknowledgeableConditionBase.install_method_handle_on_type = function _install_condition_refresh_handle(addressSpace) {

    const OPCUAServer = require("lib/server/opcua_server").OPCUAServer;
    assert(OPCUAServer != null);

    const acknowledgeableConditionType = addressSpace.findEventType("AcknowledgeableConditionType");
    assert(acknowledgeableConditionType != null);
    acknowledgeableConditionType.acknowledge.bindMethod(_acknowledge_method);
    acknowledgeableConditionType.confirm.bindMethod(_confirm_method);

};