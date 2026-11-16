/**
 * @file index.ts
 * @author Pablo Reis Rebonato
 * @description Registry of the business HTTP controllers.
 */

import { WageringController, WalletsController } from './business.controllers';

export const BusinessControllers = [WalletsController, WageringController];
