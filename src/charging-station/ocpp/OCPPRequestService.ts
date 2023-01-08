import Ajv, { type JSONSchemaType } from 'ajv';
import ajvFormats from 'ajv-formats';

import OCPPError from '../../exception/OCPPError';
import PerformanceStatistics from '../../performance/PerformanceStatistics';
import type { EmptyObject } from '../../types/EmptyObject';
import type { HandleErrorParams } from '../../types/Error';
import type { JsonObject, JsonType } from '../../types/JsonType';
import { ErrorType } from '../../types/ocpp/ErrorType';
import { MessageType } from '../../types/ocpp/MessageType';
import type { OCPPVersion } from '../../types/ocpp/OCPPVersion';
import {
  type ErrorCallback,
  type IncomingRequestCommand,
  type OutgoingRequest,
  RequestCommand,
  type RequestParams,
  type ResponseCallback,
  type ResponseType,
} from '../../types/ocpp/Requests';
import type { ErrorResponse, Response } from '../../types/ocpp/Responses';
import Constants from '../../utils/Constants';
import logger from '../../utils/Logger';
import Utils from '../../utils/Utils';
import type ChargingStation from '../ChargingStation';
import type OCPPResponseService from './OCPPResponseService';
import { OCPPServiceUtils } from './OCPPServiceUtils';

const moduleName = 'OCPPRequestService';

export default abstract class OCPPRequestService {
  private static instance: OCPPRequestService | null = null;
  private readonly version: OCPPVersion;
  private readonly ajv: Ajv;
  private readonly ocppResponseService: OCPPResponseService;
  protected abstract jsonSchemas: Map<RequestCommand, JSONSchemaType<JsonObject>>;

  protected constructor(version: OCPPVersion, ocppResponseService: OCPPResponseService) {
    this.version = version;
    this.ajv = new Ajv({
      keywords: ['javaType'],
      multipleOfPrecision: 2,
    });
    ajvFormats(this.ajv);
    this.ocppResponseService = ocppResponseService;
    this.requestHandler.bind(this);
    this.sendMessage.bind(this);
    this.sendResponse.bind(this);
    this.sendError.bind(this);
    this.internalSendMessage.bind(this);
    this.buildMessageToSend.bind(this);
    this.validateRequestPayload.bind(this);
    this.validateIncomingRequestResponsePayload.bind(this);
  }

  public static getInstance<T extends OCPPRequestService>(
    this: new (ocppResponseService: OCPPResponseService) => T,
    ocppResponseService: OCPPResponseService
  ): T {
    if (OCPPRequestService.instance === null) {
      OCPPRequestService.instance = new this(ocppResponseService);
    }
    return OCPPRequestService.instance as T;
  }

  public async sendResponse(
    chargingStation: ChargingStation,
    messageId: string,
    messagePayload: JsonType,
    commandName: IncomingRequestCommand
  ): Promise<ResponseType> {
    try {
      // Send response message
      return await this.internalSendMessage(
        chargingStation,
        messageId,
        messagePayload,
        MessageType.CALL_RESULT_MESSAGE,
        commandName
      );
    } catch (error) {
      this.handleSendMessageError(chargingStation, commandName, error as Error, {
        throwError: true,
      });
    }
  }

  public async sendError(
    chargingStation: ChargingStation,
    messageId: string,
    ocppError: OCPPError,
    commandName: RequestCommand | IncomingRequestCommand
  ): Promise<ResponseType> {
    try {
      // Send error message
      return await this.internalSendMessage(
        chargingStation,
        messageId,
        ocppError,
        MessageType.CALL_ERROR_MESSAGE,
        commandName
      );
    } catch (error) {
      this.handleSendMessageError(chargingStation, commandName, error as Error);
    }
  }

  protected async sendMessage(
    chargingStation: ChargingStation,
    messageId: string,
    messagePayload: JsonType,
    commandName: RequestCommand,
    params: RequestParams = {
      skipBufferingOnError: false,
      triggerMessage: false,
    }
  ): Promise<ResponseType> {
    try {
      return await this.internalSendMessage(
        chargingStation,
        messageId,
        messagePayload,
        MessageType.CALL_MESSAGE,
        commandName,
        params
      );
    } catch (error) {
      this.handleSendMessageError(chargingStation, commandName, error as Error);
    }
  }

  private validateRequestPayload<T extends JsonObject>(
    chargingStation: ChargingStation,
    commandName: RequestCommand | IncomingRequestCommand,
    payload: T
  ): boolean {
    if (chargingStation.getPayloadSchemaValidation() === false) {
      return true;
    }
    if (this.jsonSchemas.has(commandName as RequestCommand) === false) {
      logger.warn(
        `${chargingStation.logPrefix()} ${moduleName}.validateRequestPayload: No JSON schema found for command '${commandName}' PDU validation`
      );
      return true;
    }
    const validate = this.ajv.compile(this.jsonSchemas.get(commandName as RequestCommand));
    payload = Utils.cloneObject<T>(payload);
    OCPPServiceUtils.convertDateToISOString<T>(payload);
    if (validate(payload)) {
      return true;
    }
    logger.error(
      `${chargingStation.logPrefix()} ${moduleName}.validateRequestPayload: Command '${commandName}' request PDU is invalid: %j`,
      validate.errors
    );
    // OCPPError usage here is debatable: it's an error in the OCPP stack but not targeted to sendError().
    throw new OCPPError(
      OCPPServiceUtils.ajvErrorsToErrorType(validate.errors),
      'Request PDU is invalid',
      commandName,
      JSON.stringify(validate.errors, null, 2)
    );
  }

  private validateIncomingRequestResponsePayload<T extends JsonObject>(
    chargingStation: ChargingStation,
    commandName: RequestCommand | IncomingRequestCommand,
    payload: T
  ): boolean {
    if (chargingStation.getPayloadSchemaValidation() === false) {
      return true;
    }
    if (
      this.ocppResponseService.jsonIncomingRequestResponseSchemas.has(
        commandName as IncomingRequestCommand
      ) === false
    ) {
      logger.warn(
        `${chargingStation.logPrefix()} ${moduleName}.validateIncomingRequestResponsePayload: No JSON schema found for command '${commandName}' PDU validation`
      );
      return true;
    }
    const validate = this.ajv.compile(
      this.ocppResponseService.jsonIncomingRequestResponseSchemas.get(
        commandName as IncomingRequestCommand
      )
    );
    payload = Utils.cloneObject<T>(payload);
    OCPPServiceUtils.convertDateToISOString<T>(payload);
    if (validate(payload)) {
      return true;
    }
    logger.error(
      `${chargingStation.logPrefix()} ${moduleName}.validateIncomingRequestResponsePayload: Command '${commandName}' reponse PDU is invalid: %j`,
      validate.errors
    );
    // OCPPError usage here is debatable: it's an error in the OCPP stack but not targeted to sendError().
    throw new OCPPError(
      OCPPServiceUtils.ajvErrorsToErrorType(validate.errors),
      'Response PDU is invalid',
      commandName,
      JSON.stringify(validate.errors, null, 2)
    );
  }

  private async internalSendMessage(
    chargingStation: ChargingStation,
    messageId: string,
    messagePayload: JsonType | OCPPError,
    messageType: MessageType,
    commandName?: RequestCommand | IncomingRequestCommand,
    params: RequestParams = {
      skipBufferingOnError: false,
      triggerMessage: false,
    }
  ): Promise<ResponseType> {
    if (
      (chargingStation.isInUnknownState() === true &&
        commandName === RequestCommand.BOOT_NOTIFICATION) ||
      (chargingStation.getOcppStrictCompliance() === false &&
        chargingStation.isInUnknownState() === true) ||
      chargingStation.isInAcceptedState() === true ||
      (chargingStation.isInPendingState() === true &&
        (params.triggerMessage === true || messageType === MessageType.CALL_RESULT_MESSAGE))
    ) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      // Send a message through wsConnection
      return Utils.promiseWithTimeout(
        new Promise((resolve, reject) => {
          const messageToSend = this.buildMessageToSend(
            chargingStation,
            messageId,
            messagePayload,
            messageType,
            commandName,
            responseCallback,
            errorCallback
          );
          if (chargingStation.getEnableStatistics() === true) {
            chargingStation.performanceStatistics.addRequestStatistic(commandName, messageType);
          }
          // Check if wsConnection opened
          if (chargingStation.isWebSocketConnectionOpened() === true) {
            // Yes: Send Message
            const beginId = PerformanceStatistics.beginMeasure(commandName as string);
            // FIXME: Handle sending error
            chargingStation.wsConnection.send(messageToSend);
            PerformanceStatistics.endMeasure(commandName as string, beginId);
            logger.debug(
              `${chargingStation.logPrefix()} >> Command '${commandName}' sent ${this.getMessageTypeString(
                messageType
              )} payload: ${messageToSend}`
            );
          } else if (params.skipBufferingOnError === false) {
            // Buffer it
            chargingStation.bufferMessage(messageToSend);
            const ocppError = new OCPPError(
              ErrorType.GENERIC_ERROR,
              `WebSocket closed for buffered message id '${messageId}' with content '${messageToSend}'`,
              commandName,
              (messagePayload as JsonObject)?.details ?? {}
            );
            if (messageType === MessageType.CALL_MESSAGE) {
              // Reject it but keep the request in the cache
              return reject(ocppError);
            }
            return errorCallback(ocppError, false);
          } else {
            // Reject it
            return errorCallback(
              new OCPPError(
                ErrorType.GENERIC_ERROR,
                `WebSocket closed for non buffered message id '${messageId}' with content '${messageToSend}'`,
                commandName,
                (messagePayload as JsonObject)?.details ?? {}
              ),
              false
            );
          }
          // Response?
          if (messageType !== MessageType.CALL_MESSAGE) {
            // Yes: send Ok
            return resolve(messagePayload);
          }

          /**
           * Function that will receive the request's response
           *
           * @param payload -
           * @param requestPayload -
           */
          function responseCallback(payload: JsonType, requestPayload: JsonType): void {
            if (chargingStation.getEnableStatistics() === true) {
              chargingStation.performanceStatistics.addRequestStatistic(
                commandName,
                MessageType.CALL_RESULT_MESSAGE
              );
            }
            // Handle the request's response
            self.ocppResponseService
              .responseHandler(
                chargingStation,
                commandName as RequestCommand,
                payload,
                requestPayload
              )
              .then(() => {
                resolve(payload);
              })
              .catch((error) => {
                reject(error);
              })
              .finally(() => {
                chargingStation.requests.delete(messageId);
              });
          }

          /**
           * Function that will receive the request's error response
           *
           * @param error -
           * @param requestStatistic -
           */
          function errorCallback(error: OCPPError, requestStatistic = true): void {
            if (requestStatistic === true && chargingStation.getEnableStatistics() === true) {
              chargingStation.performanceStatistics.addRequestStatistic(
                commandName,
                MessageType.CALL_ERROR_MESSAGE
              );
            }
            logger.error(
              `${chargingStation.logPrefix()} Error occurred when calling command ${commandName} with message data ${JSON.stringify(
                messagePayload
              )}:`,
              error
            );
            chargingStation.requests.delete(messageId);
            reject(error);
          }
        }),
        Constants.OCPP_WEBSOCKET_TIMEOUT,
        new OCPPError(
          ErrorType.GENERIC_ERROR,
          `Timeout for message id '${messageId}'`,
          commandName,
          (messagePayload as JsonObject)?.details ?? {}
        ),
        () => {
          messageType === MessageType.CALL_MESSAGE && chargingStation.requests.delete(messageId);
        }
      );
    }
    throw new OCPPError(
      ErrorType.SECURITY_ERROR,
      `Cannot send command ${commandName} PDU when the charging station is in ${chargingStation.getRegistrationStatus()} state on the central server`,
      commandName
    );
  }

  private buildMessageToSend(
    chargingStation: ChargingStation,
    messageId: string,
    messagePayload: JsonType | OCPPError,
    messageType: MessageType,
    commandName?: RequestCommand | IncomingRequestCommand,
    responseCallback?: ResponseCallback,
    errorCallback?: ErrorCallback
  ): string {
    let messageToSend: string;
    // Type of message
    switch (messageType) {
      // Request
      case MessageType.CALL_MESSAGE:
        // Build request
        chargingStation.requests.set(messageId, [
          responseCallback,
          errorCallback,
          commandName,
          messagePayload as JsonType,
        ]);
        this.validateRequestPayload(chargingStation, commandName, messagePayload as JsonObject);
        messageToSend = JSON.stringify([
          messageType,
          messageId,
          commandName,
          messagePayload,
        ] as OutgoingRequest);
        break;
      // Response
      case MessageType.CALL_RESULT_MESSAGE:
        // Build response
        this.validateIncomingRequestResponsePayload(
          chargingStation,
          commandName,
          messagePayload as JsonObject
        );
        messageToSend = JSON.stringify([messageType, messageId, messagePayload] as Response);
        break;
      // Error Message
      case MessageType.CALL_ERROR_MESSAGE:
        // Build Error Message
        messageToSend = JSON.stringify([
          messageType,
          messageId,
          (messagePayload as OCPPError)?.code ?? ErrorType.GENERIC_ERROR,
          (messagePayload as OCPPError)?.message ?? '',
          (messagePayload as OCPPError)?.details ?? { commandName },
        ] as ErrorResponse);
        break;
    }
    return messageToSend;
  }

  private getMessageTypeString(messageType: MessageType): string {
    switch (messageType) {
      case MessageType.CALL_MESSAGE:
        return 'request';
      case MessageType.CALL_RESULT_MESSAGE:
        return 'response';
      case MessageType.CALL_ERROR_MESSAGE:
        return 'error';
    }
  }

  private handleSendMessageError(
    chargingStation: ChargingStation,
    commandName: RequestCommand | IncomingRequestCommand,
    error: Error,
    params: HandleErrorParams<EmptyObject> = { throwError: false }
  ): void {
    logger.error(`${chargingStation.logPrefix()} Request command '${commandName}' error:`, error);
    if (params?.throwError === true) {
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public abstract requestHandler<ReqType extends JsonType, ResType extends JsonType>(
    chargingStation: ChargingStation,
    commandName: RequestCommand,
    commandParams?: JsonType,
    params?: RequestParams
  ): Promise<ResType>;
}
