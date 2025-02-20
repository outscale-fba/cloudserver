'use strict'; // eslint-disable-line strict
const assert = require('assert');
const DummyRequestLogger = require('../unit/helpers').DummyRequestLogger;
const clientCheck
    = require('../../lib/utilities/healthcheckHandler').clientCheck;
const { config } = require('../../lib/Config');
const {
    getAzureClient,
    azureLocationNonExistContainer,
    getAzureContainerName,
} = require('../functional/aws-node-sdk/test/multipleBackend/utils');

const log = new DummyRequestLogger();
const locConstraints = Object.keys(config.locationConstraints);
const azureClient = getAzureClient();

describe('Healthcheck response', () => {
    it('should return result for every location constraint in ' +
    'locationConfig and every external locations with flightCheckOnStartUp ' +
    'set to true', done => {
        clientCheck(true, log, (err, results) => {
            const resultKeys = Object.keys(results);
            locConstraints.forEach(constraint => {
                if (constraint === 'location-dmf-v1') {
                    // FIXME: location-dmf-v1 is not in results, see CLDSRV-440
                    return;
                }
                assert(resultKeys.includes(constraint), `constraint: ${constraint} not in results: ${resultKeys}`);
            });
            done();
        });
    });
    it('should return no error with flightCheckOnStartUp set to false',
    done => {
        clientCheck(false, log, err => {
            assert.strictEqual(err, null,
                `Expected success but got error ${err}`);
            done();
        });
    });
    it('should return result for every location constraint in ' +
    'locationConfig and at least one of every external locations with ' +
    'flightCheckOnStartUp set to false', done => {
        clientCheck(false, log, (err, results) => {
            assert.notStrictEqual(results.length, locConstraints.length);
            locConstraints.forEach(constraint => {
                if (constraint === 'location-dmf-v1') {
                    // FIXME: location-dmf-v1 is not in results, see CLDSRV-440
                    return;
                }
                if (Object.keys(results).indexOf(constraint) === -1) {
                    const locationType = config
                        .locationConstraints[constraint].type;
                    assert(Object.keys(results).some(result =>
                      config.locationConstraints[result].type
                        === locationType));
                }
            });
            done();
        });
    });

    // FIXME: does not pass, see CLDSRV-441
    describe.skip('Azure container creation', () => {
        const containerName =
            getAzureContainerName(azureLocationNonExistContainer);

        beforeEach(async () => {
            await azureClient.getContainerClient(containerName).deleteIfExists();
        });

        afterEach(async () => {
            await azureClient.getContainerClient(containerName).deleteIfExists();
        });

        it('should create an azure location\'s container if it is missing ' +
        'and the check is a flightCheckOnStartUp', done => {
            clientCheck(true, log, (err, results) => {
                const azureLocationNonExistContainerError =
                    results[azureLocationNonExistContainer].error;
                if (err) {
                    assert(err.is.InternalError, `got unexpected err in clientCheck: ${err}`);
                    assert(azureLocationNonExistContainerError.startsWith(
                        'The specified container is being deleted.'));
                    return done();
                }
                return azureClient.getContainerClient(containerName).getProperties(
                    azureResult => {
                        assert.strictEqual(azureResult.metadata.name, containerName);
                        return done();
                    }, err => {
                        assert.strictEqual(err, null, 'got unexpected err ' +
                            `heading azure container: ${err}`);
                        return done();
                    });
            });
        });

        it('should not create an azure location\'s container even if it is ' +
        'missing if the check is not a flightCheckOnStartUp', done => {
            clientCheck(false, log, err => {
                assert.strictEqual(err, null,
                    `got unexpected err in clientCheck: ${err}`);
                return azureClient.getContainerClient(containerName).getProperties().then(
                    () => {
                        assert(err, 'Expected err but did not find one');
                        return done();
                    }, err => {
                        assert.strictEqual(err.code, 'NotFound',
                            `got unexpected err code in clientCheck: ${err.code}`);
                        return done();
                    });
            });
        });
    });
});
