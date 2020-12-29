/* eslint-disable no-await-in-loop */
const get = require("get-value");
const set = require("set-value");
const axios = require("axios");
const { EventType } = require("../../../constants");
const {
  defaultBatchRequestConfig,
  defaultGetRequestConfig,
  defaultPostRequestConfig,
  defaultRequestConfig,
  removeUndefinedValues,
  getFieldValueFromMessage
} = require("../../util");
const logger = require("../../../logger");
const { ConfigCategory, mappingConfig } = require("./config");

const hSIdentifyConfigJson = mappingConfig[ConfigCategory.IDENTIFY.name];

let hubSpotPropertyMap = {};

function getKey(key) {
  let modifiedKey = key.toLowerCase();
  modifiedKey = modifiedKey.replace(/\s/g, "_");
  modifiedKey = modifiedKey.replace(/\./g, "_");
  return modifiedKey;
}

async function getProperties(destination) {
  if (!hubSpotPropertyMap.length) {
    const { apiKey } = destination.Config;
    const url = `https://api.hubapi.com/properties/v1/contacts/properties?hapikey=${apiKey}`;
    const response = await axios.get(url);
    const propertyMap = {};
    response.data.forEach(element => {
      propertyMap[element.name] = element.type;
    });
    hubSpotPropertyMap = propertyMap;
  }
  return hubSpotPropertyMap;
}

async function getTransformedJSON(message, mappingJson, destination) {
  const rawPayload = {};

  const sourceKeys = Object.keys(mappingJson);
  const traits = getFieldValueFromMessage(message, "traits");
  if (traits) {
    const traitsKeys = Object.keys(traits);
    const propertyMap = await getProperties(destination);
    sourceKeys.forEach(sourceKey => {
      if (get(traits, sourceKey)) {
        set(rawPayload, mappingJson[sourceKey], get(traits, sourceKey));
      }
    });
    traitsKeys.forEach(traitsKey => {
      const hsSupportedKey = getKey(traitsKey);
      if (!rawPayload[traitsKey] && propertyMap[hsSupportedKey]) {
        let propValue = traits[traitsKey];
        if (propertyMap[hsSupportedKey] === "date") {
          const time = propValue;
          const date = new Date(time);
          date.setUTCHours(0, 0, 0, 0);
          propValue = date.getTime();
        }
        rawPayload[hsSupportedKey] = propValue;
      }
    });
  }
  return { ...rawPayload };
}

function getPropertyValueForIdentify(propMap) {
  return Object.keys(propMap).map(key => {
    return { property: key, value: propMap[key] };
  });
}

function responseBuilderSimple(payload, message, eventType, destination) {
  let endpoint = "https://track.hubspot.com/v1/event";
  let params = {};

  const response = defaultRequestConfig();
  response.method = defaultGetRequestConfig.requestMethod;

  if (eventType !== EventType.TRACK) {
    const traits = getFieldValueFromMessage(message, "traits");
    const { email } = traits;
    const { apiKey } = destination.Config;
    params = { hapikey: apiKey };
    if (email) {
      endpoint = `https://api.hubapi.com/contacts/v1/contact/createOrUpdate/email/${email}`;
    } else {
      endpoint = "https://api.hubapi.com/contacts/v1/contact";
    }
    response.method = defaultPostRequestConfig.requestMethod;
    response.body.JSON = removeUndefinedValues(payload);
  } else {
    params = removeUndefinedValues(payload);
  }
  response.headers = {
    "Content-Type": "application/json"
  };
  response.endpoint = endpoint;
  response.userId = message.anonymousId;
  response.params = params;
  response.statusCode = 200;

  return response;
}

async function processTrack(message, destination) {
  const parameters = {
    _a: destination.Config.hubID,
    _n: message.event
  };

  if (message.properties.revenue || message.properties.value) {
    // eslint-disable-next-line dot-notation
    parameters["_m"] = message.properties.revenue || message.properties.value;
  }
  const userProperties = await getTransformedJSON(
    message,
    hSIdentifyConfigJson,
    destination
  );

  return responseBuilderSimple(
    { ...parameters, ...userProperties },
    message,
    EventType.TRACK,
    destination
  );
}

async function processIdentify(message, destination) {
  const userProperties = await getTransformedJSON(
    message,
    hSIdentifyConfigJson,
    destination
  );
  const properties = getPropertyValueForIdentify(userProperties);
  return responseBuilderSimple(
    { properties },
    message,
    EventType.IDENTIFY,
    destination
  );
}

async function processSingleMessage(message, destination) {
  let response;
  switch (message.type) {
    case EventType.TRACK:
      response = await processTrack(message, destination);
      break;
    case EventType.IDENTIFY:
      response = await processIdentify(message, destination);
      break;
    default:
      throw new Error(`message type ${message.type} is not supported`);
  }
  return response;
}

function validateIdentify(message) {
  const email = getFieldValueFromMessage(message, "email");
  if (!email) {
    throw new Error("Identify without email is not supported.");
  }
}

function filterMessage(message) {
  const messageType = message.type.toLowerCase();
  switch (messageType) {
    case EventType.IDENTIFY:
      validateIdentify(message);
      return message;
    case EventType.TRACK:
      return message;
    default:
      throw new Error("Message type is not supported");
  }
}

function process(event) {
  return filterMessage(event.message);
}

const formatBatchResponse = (batchPayload, metadataList, destination) => {
  const response = defaultBatchRequestConfig();
  response.batchedRequest = batchPayload;
  response.metadata = metadataList;
  response.destination = destination;
  return response;
};

const batch = async destEvents => {
  const respList = [];
  for (let index = 0; index < destEvents.length; index += 1) {
    const ev = destEvents[index];
    const { message, metadata, destination } = ev;
    if (message.statusCode) {
      // processed event
      respList.push(formatBatchResponse(message, [metadata], destination));
    } else {
      // unprocessed event
      try {
        const singleResponse = await processSingleMessage(message, destination);
        if (singleResponse) {
          respList.push(
            formatBatchResponse(singleResponse, [metadata], destination)
          );
        }
      } catch (error) {
        logger.error(error);
      }
    }
  }
  return respList;
};

module.exports = {
  process,
  batch
};
